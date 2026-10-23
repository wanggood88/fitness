package com.wanggood88.fit

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * 安卓「健康」数据（Health Connect）读取层。
 *
 * 版本兼容：
 *  - API 34+（Android 14+）：Health Connect 是系统模块，直接可用。
 *  - API 28–33：需用户自行安装 Health Connect 应用（com.google.android.apps.healthdata）。
 *  - API < 28：不支持（客户端库本身也要求 minSdk 26）。
 *
 * 读取窗口默认 30 天：Health Connect 对未申请
 * PERMISSION_READ_HEALTH_DATA_HISTORY 的应用只开放最近 30 天数据。
 *
 * 输出格式对齐前端 health.js 的 normalizeExternal() 契约：
 *   {workouts:[{title,type,start,end,dur,kcal,hr,hrMax,dist,distUnit,source}]}
 * start/end 为毫秒时间戳，dist 单位为公里。
 */
object AndroidHealth {

    const val PROVIDER_PKG = "com.google.android.apps.healthdata"

    /** 需要的读取权限（最小可用集合） */
    val PERMISSIONS: Set<String> = linkedSetOf(
        HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        HealthPermission.getReadPermission(HeartRateRecord::class),
        HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
        HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
        HealthPermission.getReadPermission(DistanceRecord::class),
        HealthPermission.getReadPermission(StepsRecord::class),
        HealthPermission.getReadPermission(WeightRecord::class),
        HealthPermission.getReadPermission(SleepSessionRecord::class)
    )

    /* ---------------- 厂商健康 App 探测 ---------------- */

    /**
     * 常见厂商健康 App 的包名。国产 ROM 的健康 App 普遍不写入 Health Connect，
     * 探测到它们存在时，前端可以提示用户改用「导出文件导入」这条路。
     */
    private val VENDOR_APPS = linkedMapOf(
        "小米运动健康" to listOf("com.miui.hm", "com.xiaomi.hm.health"),
        "华为运动健康" to listOf("com.huawei.hwid", "com.huawei.health"),
        "欢太健康" to listOf("com.heytap.health", "com.oppo.health"),
        "vivo 健康" to listOf("com.vivo.health", "com.iqoo.health"),
        "Zepp Life" to listOf("com.huami.midong", "com.amazfitmidong")
    )

    /** 已安装的厂商健康 App 名称列表（空表示都没装） */
    @JvmStatic
    fun vendorApps(context: Context): List<String> {
        val pm = context.packageManager
        val out = ArrayList<String>()
        for ((label, pkgs) in VENDOR_APPS) {
            for (pkg in pkgs) {
                try {
                    pm.getApplicationInfo(pkg, 0)
                    out.add(label)
                    break
                } catch (t: Throwable) {
                    // 未安装，继续下一个
                }
            }
        }
        return out
    }

    /* ---------------- 可用性 ---------------- */

    /** SDK 状态：3=可用 2=provider 版本过旧 1=不可用 */
    @JvmStatic
    fun sdkStatus(context: Context): Int = try {
        HealthConnectClient.getSdkStatus(context, PROVIDER_PKG)
    } catch (t: Throwable) {
        HealthConnectClient.SDK_UNAVAILABLE
    }

    @JvmStatic
    fun isAvailable(context: Context): Boolean = sdkStatus(context) == HealthConnectClient.SDK_AVAILABLE

    private fun client(context: Context): HealthConnectClient? = try {
        HealthConnectClient.getOrCreate(context, PROVIDER_PKG)
    } catch (t: Throwable) {
        null
    }

    /** 已授权权限（getGrantedPermissions 是 suspend，这里同步阻塞等待） */
    @JvmStatic
    fun grantedPermissions(context: Context): Set<String> = try {
        val c = client(context) ?: return emptySet()
        runBlocking { c.permissionController.getGrantedPermissions() }
    } catch (t: Throwable) {
        emptySet()
    }

    /** 尚未授权的权限 */
    @JvmStatic
    fun missingPermissions(context: Context): Set<String> {
        val granted = grantedPermissions(context)
        return PERMISSIONS.filter { it !in granted }.toSet()
    }

    /** 打开 Health Connect 的「管理数据」设置页（用户永久拒绝权限时的兜底入口） */
    @JvmStatic
    fun manageDataIntent(context: Context): Intent? = try {
        HealthConnectClient.getHealthConnectManageDataIntent(context, PROVIDER_PKG)
    } catch (t: Throwable) {
        null
    }

    /** 打开应用商店安装 Health Connect（API 28–33 未安装时用） */
    @JvmStatic
    fun installIntent(): Intent = Intent(
        Intent.ACTION_VIEW,
        Uri.parse("market://details?id=$PROVIDER_PKG")
    )

    /* ---------------- 读取 ---------------- */

    /** 读取结果回调（Java 侧实现，避免依赖 java.util.function 的 API 24+ 限制） */
    interface Callback {
        fun onResult(data: JSONObject)
    }

    /** 后台线程读取，结果回调到主线程 */
    @JvmStatic
    fun readAsync(context: Context, days: Int, cb: Callback) {
        val app = context.applicationContext
        Thread {
            val out = try {
                read(app, days)
            } catch (t: Throwable) {
                JSONObject().apply {
                    put("ok", false)
                    put("error", t.message ?: t.javaClass.simpleName)
                }
            }
            android.os.Handler(android.os.Looper.getMainLooper()).post { cb.onResult(out) }
        }.start()
    }

    private fun read(context: Context, days: Int): JSONObject = runBlocking {
        withContext(Dispatchers.IO) {
            val c = client(context) ?: throw IllegalStateException("健康数据服务不可用")
            val end = Instant.now()
            val start = end.minus(days.toLong(), ChronoUnit.DAYS)
            val filter = TimeRangeFilter.between(start, end)

            val workouts = JSONArray()
            val sessions = readAll(c, ExerciseSessionRecord::class, filter)
            val hrRecords = readAll(c, HeartRateRecord::class, filter)
            val activeCal = readAll(c, ActiveCaloriesBurnedRecord::class, filter)
            val totalCal = readAll(c, TotalCaloriesBurnedRecord::class, filter)
            val distances = readAll(c, DistanceRecord::class, filter)

            for (s in sessions) {
                val sStart = s.startTime.toEpochMilli()
                val sEnd = s.endTime.toEpochMilli()
                val dur = ((sEnd - sStart) / 1000L).toInt()
                if (dur < 60) continue // 太短的碎片记录没有参考价值

                val w = JSONObject()
                w.put("title", titleOf(s.exerciseType, s.title))
                w.put("type", typeOf(s.exerciseType))
                w.put("start", sStart)
                w.put("end", sEnd)
                w.put("dur", dur)
                w.put("source", sourceOf(context, s))

                // 心率：落在该时间段内的样本求均值与峰值
                var sum = 0L
                var cnt = 0
                var max = 0L
                for (hr in hrRecords) {
                    for (sample in hr.samples) {
                        val t = sample.time.toEpochMilli()
                        if (t < sStart || t > sEnd) continue
                        val bpm = sample.beatsPerMinute
                        sum += bpm
                        cnt++
                        if (bpm > max) max = bpm
                    }
                }
                if (cnt > 0) {
                    w.put("hr", Math.round(sum.toDouble() / cnt))
                    if (max > 0) w.put("hrMax", max)
                }

                // 消耗：优先用「活动热量」，没有则退回「总热量」；按时间重叠比例折算
                val kcal = energyIn(activeCal, totalCal, sStart, sEnd)
                if (kcal > 0) w.put("kcal", Math.round(kcal))

                // 距离：按时间重叠比例折算，单位从米换成公里
                val distM = distanceIn(distances, sStart, sEnd)
                if (distM > 0) {
                    w.put("dist", Math.round(distM / 1000.0 * 100.0) / 100.0)
                    w.put("distUnit", "km")
                }

                workouts.put(w)
            }

            JSONObject().apply {
                put("ok", true)
                put("from", start.toEpochMilli())
                put("to", end.toEpochMilli())
                put("workouts", workouts)
                put("count", workouts.length())
                put("steps", stepsIn(c, filter))
                put("weightKg", weightIn(c, filter))
                put("sleepMinutes", sleepIn(c, filter))
                put("vendorApps", org.json.JSONArray(vendorApps(context)))
            }
        }
    }

    /* ---------------- 各类记录的聚合 ---------------- */

    private suspend inline fun <reified T : Record> readAll(
        c: HealthConnectClient,
        klass: kotlin.reflect.KClass<T>,
        filter: TimeRangeFilter
    ): List<T> = try {
        c.readRecords(ReadRecordsRequest(klass, filter)).records
    } catch (t: Throwable) {
        emptyList()
    }

    private fun energyIn(
        active: List<ActiveCaloriesBurnedRecord>,
        total: List<TotalCaloriesBurnedRecord>,
        start: Long,
        end: Long
    ): Double {
        val primary: List<Triple<Long, Long, Double>> = if (active.isNotEmpty()) {
            active.map { Triple(it.startTime.toEpochMilli(), it.endTime.toEpochMilli(), it.energy.inKilocalories) }
        } else {
            total.map { Triple(it.startTime.toEpochMilli(), it.endTime.toEpochMilli(), it.energy.inKilocalories) }
        }
        return overlapSum(primary, start, end)
    }

    private fun distanceIn(list: List<DistanceRecord>, start: Long, end: Long): Double {
        val triples: List<Triple<Long, Long, Double>> =
            list.map { Triple(it.startTime.toEpochMilli(), it.endTime.toEpochMilli(), it.distance.inMeters) }
        return overlapSum(triples, start, end)
    }

    /** 把区间记录按与目标窗口的重叠比例折算后求和 */
    private fun overlapSum(items: List<Triple<Long, Long, Double>>, start: Long, end: Long): Double {
        var sum = 0.0
        for ((s, e, v) in items) {
            val os = maxOf(s, start)
            val oe = minOf(e, end)
            if (oe <= os) continue
            val own = e - s
            sum += if (own > 0) v * (oe - os).toDouble() / own.toDouble() else v
        }
        return sum
    }

    private suspend fun stepsIn(c: HealthConnectClient, filter: TimeRangeFilter): Long = try {
        c.readRecords(ReadRecordsRequest(StepsRecord::class, filter)).records.sumOf { it.count }
    } catch (t: Throwable) {
        0L
    }

    private suspend fun weightIn(c: HealthConnectClient, filter: TimeRangeFilter): Double = try {
        c.readRecords(ReadRecordsRequest(WeightRecord::class, filter))
            .records.maxByOrNull { it.time }?.weight?.inKilograms ?: 0.0
    } catch (t: Throwable) {
        0.0
    }

    private suspend fun sleepIn(c: HealthConnectClient, filter: TimeRangeFilter): Long = try {
        c.readRecords(ReadRecordsRequest(SleepSessionRecord::class, filter)).records.sumOf {
            ChronoUnit.MINUTES.between(it.startTime, it.endTime)
        }
    } catch (t: Throwable) {
        0L
    }

    /* ---------------- 运动类型映射 ---------------- */

    private fun sourceOf(context: Context, s: ExerciseSessionRecord): String {
        val pkg = s.metadata?.dataOrigin?.packageName
        if (pkg.isNullOrEmpty()) return "健康"
        return try {
            val pm = context.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        } catch (t: Throwable) {
            pkg
        }
    }

    /** 中文标题：优先用内置运动类型名，其次用 Health Connect 自带标题 */
    private fun titleOf(type: Int, fallback: String?): String {
        val t = nameOf(type)
        if (t.isNotEmpty()) return t
        return fallback?.takeIf { it.isNotEmpty() } ?: "训练"
    }

    /** 运动类型 → 中文名 */
    private fun nameOf(type: Int): String = when (type) {
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING -> "跑步"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "跑步"
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "步行"
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING -> "HIIT"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING -> "力量训练"
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING -> "力量训练"
        ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS -> "功能力量训练"
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "瑜伽"
        ExerciseSessionRecord.EXERCISE_TYPE_PILATES -> "普拉提"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING -> "划船"
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL -> "椭圆机"
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING -> "爬楼"
        ExerciseSessionRecord.EXERCISE_TYPE_STRETCHING -> "拉伸"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING -> "骑行"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> "骑行"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL -> "游泳"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER -> "游泳"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "徒步"
        ExerciseSessionRecord.EXERCISE_TYPE_DANCING -> "舞蹈"
        ExerciseSessionRecord.EXERCISE_TYPE_BADMINTON -> "羽毛球"
        ExerciseSessionRecord.EXERCISE_TYPE_TENNIS -> "网球"
        ExerciseSessionRecord.EXERCISE_TYPE_SKATING -> "滑冰"
        ExerciseSessionRecord.EXERCISE_TYPE_BOXING -> "拳击"
        ExerciseSessionRecord.EXERCISE_TYPE_BOOT_CAMP -> "健身训练"
        ExerciseSessionRecord.EXERCISE_TYPE_MARTIAL_ARTS -> "武术"
        ExerciseSessionRecord.EXERCISE_TYPE_ROLLER_HOCKEY -> "轮滑冰球"
        ExerciseSessionRecord.EXERCISE_TYPE_SOCCER -> "足球"
        ExerciseSessionRecord.EXERCISE_TYPE_BASKETBALL -> "篮球"
        ExerciseSessionRecord.EXERCISE_TYPE_GOLF -> "高尔夫"
        ExerciseSessionRecord.EXERCISE_TYPE_ROCK_CLIMBING -> "攀岩"
        ExerciseSessionRecord.EXERCISE_TYPE_SKIING -> "滑雪"
        ExerciseSessionRecord.EXERCISE_TYPE_SNOWBOARDING -> "单板滑雪"
        ExerciseSessionRecord.EXERCISE_TYPE_GYMNASTICS -> "体操"
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_SKATING -> "滑冰"
        ExerciseSessionRecord.EXERCISE_TYPE_PADDLING -> "水上运动"
        else -> ""
    }

    /**
     * 返回 Apple 风格的 type 标识，从而直接复用前端 health.js 已有的 ACT 映射表
     * （跑步 / 步行 / 骑行 / 力量训练 …），前后端标题口径保持一致。
     */
    private fun typeOf(type: Int): String = when (type) {
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING -> "HKWorkoutActivityTypeRunning"
        ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL -> "HKWorkoutActivityTypeRunning"
        ExerciseSessionRecord.EXERCISE_TYPE_WALKING -> "HKWorkoutActivityTypeWalking"
        ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING ->
            "HKWorkoutActivityTypeHighIntensityIntervalTraining"
        ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING ->
            "HKWorkoutActivityTypeTraditionalStrengthTraining"
        ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING ->
            "HKWorkoutActivityTypeTraditionalStrengthTraining"
        ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS ->
            "HKWorkoutActivityTypeFunctionalStrengthTraining"
        ExerciseSessionRecord.EXERCISE_TYPE_YOGA -> "HKWorkoutActivityTypeYoga"
        ExerciseSessionRecord.EXERCISE_TYPE_PILATES -> "HKWorkoutActivityTypePilates"
        ExerciseSessionRecord.EXERCISE_TYPE_ROWING -> "HKWorkoutActivityTypeRowing"
        ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL -> "HKWorkoutActivityTypeElliptical"
        ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING -> "HKWorkoutActivityTypeStairClimbing"
        ExerciseSessionRecord.EXERCISE_TYPE_STRETCHING -> "HKWorkoutActivityTypeFlexibility"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING -> "HKWorkoutActivityTypeCycling"
        ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY -> "HKWorkoutActivityTypeCycling"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL -> "HKWorkoutActivityTypeSwimming"
        ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER -> "HKWorkoutActivityTypeSwimming"
        ExerciseSessionRecord.EXERCISE_TYPE_HIKING -> "HKWorkoutActivityTypeHiking"
        ExerciseSessionRecord.EXERCISE_TYPE_DANCING -> "HKWorkoutActivityTypeDance"
        ExerciseSessionRecord.EXERCISE_TYPE_BADMINTON -> "HKWorkoutActivityTypeBadminton"
        ExerciseSessionRecord.EXERCISE_TYPE_TENNIS -> "HKWorkoutActivityTypeTennis"
        ExerciseSessionRecord.EXERCISE_TYPE_SKATING -> "HKWorkoutActivityTypeSkatingSports"
        ExerciseSessionRecord.EXERCISE_TYPE_BOXING -> "HKWorkoutActivityTypeBoxing"
        ExerciseSessionRecord.EXERCISE_TYPE_BOOT_CAMP -> "HKWorkoutActivityTypeBootCamp"
        ExerciseSessionRecord.EXERCISE_TYPE_MARTIAL_ARTS -> "HKWorkoutActivityTypeMartialArts"
        ExerciseSessionRecord.EXERCISE_TYPE_ROLLER_HOCKEY -> "HKWorkoutActivityTypeHockey"
        ExerciseSessionRecord.EXERCISE_TYPE_SOCCER -> "HKWorkoutActivityTypeSoccer"
        ExerciseSessionRecord.EXERCISE_TYPE_BASKETBALL -> "HKWorkoutActivityTypeBasketball"
        ExerciseSessionRecord.EXERCISE_TYPE_GOLF -> "HKWorkoutActivityTypeGolf"
        ExerciseSessionRecord.EXERCISE_TYPE_ROCK_CLIMBING -> "HKWorkoutActivityTypeClimbing"
        ExerciseSessionRecord.EXERCISE_TYPE_SKIING -> "HKWorkoutActivityTypeDownhillSkiing"
        ExerciseSessionRecord.EXERCISE_TYPE_SNOWBOARDING -> "HKWorkoutActivityTypeSnowboarding"
        ExerciseSessionRecord.EXERCISE_TYPE_GYMNASTICS -> "HKWorkoutActivityTypeGymnastics"
        ExerciseSessionRecord.EXERCISE_TYPE_ICE_SKATING -> "HKWorkoutActivityTypeIceSkating"
        ExerciseSessionRecord.EXERCISE_TYPE_PADDLING -> "HKWorkoutActivityTypePaddleSports"
        else -> ""
    }
}
