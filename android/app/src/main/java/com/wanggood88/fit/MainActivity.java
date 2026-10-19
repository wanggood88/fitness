package com.wanggood88.fit;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.NotificationCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebSettingsCompat;

import org.json.JSONObject;

import java.io.InputStream;

/**
 * 离线 WebView 壳：全部网页资源打进 APK（assets/app/），通过 WebViewAssetLoader
 * 以 https://appassets.androidplatform.net/app/ 加载（secure origin，IndexedDB 可用）。
 * 原生桥：keepAwake（训练亮屏）+ msUpdate（音乐状态 → 系统媒体通知，WebView 不自带）。
 */
public class MainActivity extends AppCompatActivity {
    private static final String VIRTUAL_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + VIRTUAL_HOST + "/app/index.html";
    private static final int FILE_REQ = 4001;
    private static final int NOTIF_ID = 36;
    private static final String CHANNEL_ID = "media";
    private static final int FLAG_KEEP_SCREEN_ON = 0x00000080;

    private WebView web;
    private ValueCallback<Uri[]> fileCb;
    private MediaSessionCompat session;
    private NotificationManager nm;
    private Bitmap art;
    private String lastTitle;
    private boolean notifPosted;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);
        nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        try { WebSettingsCompat.setForceDark(s, WebSettingsCompat.FORCE_DARK_OFF); } catch (Throwable ignored) {}
        web.setBackgroundColor(0xFF0D1117);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                /* PathHandler 收到的是剥掉 /app/ 前缀后的路径，需手动映射到 assets/app/ */
                .addPathHandler("/app/", new WebViewAssetLoader.PathHandler() {
                    @Nullable
                    @Override
                    public InputStream handle(@NonNull String path) {
                        try { return getAssets().open("app/" + path); } catch (Exception e) { return null; }
                    }
                })
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return loader.shouldInterceptRequest(r.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (VIRTUAL_HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try { startActivityForResult(p.createIntent(), FILE_REQ); } catch (Exception e) {
                    fileCb = null;
                    cb.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        session = new MediaSessionCompat(this, "FitMusic");
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onPlay() { js("if(window.FITMUSIC&&FITMUSIC.setPaused)FITMUSIC.setPaused(false)"); }
            @Override public void onPause() { js("if(window.FITMUSIC&&FITMUSIC.setPaused)FITMUSIC.setPaused(true)"); }
            @Override public void onSkipToNext() { js("if(window.FITMUSIC&&FITMUSIC.next)FITMUSIC.next()"); }
            @Override public void onSkipToPrevious() { js("if(window.FITMUSIC&&FITMUSIC.prev)FITMUSIC.prev()"); }
            @Override public void onSeekTo(long pos) { js("if(window.FITMUSIC&&FITMUSIC.seek)FITMUSIC.seek(" + (pos / 1000.0) + ")"); }
        });
        session.setActive(true);

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 7);
        }

        web.loadUrl(START_URL);
    }

    private void js(final String code) {
        runOnUiThread(new Runnable() { @Override public void run() { web.evaluateJavascript(code, null); } });
    }

    /* ---------- JS 桥 ---------- */
    class Bridge {
        @JavascriptInterface
        public void keepAwake(final boolean on) {
            runOnUiThread(new Runnable() { @Override public void run() { web.setKeepScreenOn(on); } });
        }

        @JavascriptInterface
        public void msUpdate(final String json) {
            runOnUiThread(new Runnable() { @Override public void run() { applyMedia(json); } });
        }
    }

    /* ---------- 媒体通知（WebView 不自带，原生补齐） ---------- */
    private void applyMedia(String json) {
        try {
            JSONObject o = new JSONObject(json);
            String title = o.optString("title", "");
            boolean playing = o.optBoolean("playing", false);
            boolean active = o.optBoolean("active", false);
            double pos = o.optDouble("pos", 0);
            double dur = o.optDouble("dur", 0);
            if (!active || title.length() == 0) {
                lastTitle = null;
                if (notifPosted) { try { nm.cancel(NOTIF_ID); } catch (Exception ignored) {} notifPosted = false; }
                session.setActive(false);
                return;
            }
            if (!session.isActive()) session.setActive(true);
            if (!title.equals(lastTitle)) {
                session.setMetadata(new MediaMetadataCompat.Builder()
                        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, "健身提醒")
                        .putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art())
                        .build());
            }
            PlaybackStateCompat.Builder pb = new PlaybackStateCompat.Builder()
                    .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE
                            | PlaybackStateCompat.ACTION_PLAY_PAUSE | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
                            | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS | PlaybackStateCompat.ACTION_SEEK_TO)
                    .setState(playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED,
                            (long) (Math.max(0, pos) * 1000), playing ? 1f : 0f);
            if (dur > 0) pb.setBufferedPosition((long) (dur * 1000));
            session.setPlaybackState(pb.build());
            if (!notifPosted || !title.equals(lastTitle)) postNotif(title);
            lastTitle = title;
        } catch (Exception ignored) {}
    }

    private void postNotif(String title) {
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "音乐播放", NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
            Intent ci = getPackageManager().getLaunchIntentForPackage(getPackageName());
            PendingIntent pi = ci != null ? PendingIntent.getActivity(this, 1, ci,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT) : null;
            NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_media_play)
                    .setContentTitle(title)
                    .setContentText("健身提醒")
                    .setLargeIcon(art())
                    .setContentIntent(pi)
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                            .setMediaSession(session.getSessionToken()));
            nm.notify(NOTIF_ID, b.build());
            notifPosted = true;
        } catch (Exception ignored) {}
    }

    private Bitmap art() {
        if (art != null) return art;
        try {
            InputStream is = getAssets().open("app/icon-180.png");
            art = BitmapFactory.decodeStream(is);
            is.close();
        } catch (Exception ignored) {}
        return art;
    }

    /* ---------- 生命周期 ---------- */
    @Override
    protected void onActivityResult(int req, int res, @Nullable Intent data) {
        super.onActivityResult(req, res, data);
        if (req == FILE_REQ && fileCb != null) {
            fileCb.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            fileCb = null;
        }
    }

    @Override
    public void onBackPressed() {
        moveTaskToBack(true); /* 返回键退到后台不杀会话，音乐不断 */
    }

    @Override
    protected void onDestroy() {
        if (nm != null) try { nm.cancel(NOTIF_ID); } catch (Exception ignored) {}
        if (session != null) try { session.release(); } catch (Exception ignored) {}
        super.onDestroy();
    }
}
