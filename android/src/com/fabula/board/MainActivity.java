package com.fabula.board;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Fabula 故事板 · 手机壳。
 *
 * 形态：内置直达链接（含密钥）的 WebView，打开即用、零输入——
 * 等价于把"添加到主屏幕"的 PWA 包成一个可安装的 APK。
 *
 * 关键配置：
 *  · setDomStorageEnabled —— localStorage（门户页记住密钥 / 页面逻辑）
 *  · onShowFileChooser    —— 相册选图（手机端"替换分镜图"依赖）
 *  · MIXED_CONTENT_ALWAYS_ALLOW —— 页面内不要，但 http 主站下的子资源偶尔需要
 *  · 返回键映射 webView.goBack
 *
 * 更新方式：服务端改动无需重装 APK（壳只负责打开网址）；
 * 地址/密钥变化时改 START_URL 重新构建即可（android/build-apk.ps1）。
 */
public class MainActivity extends Activity {

    /* 直达链接 = 固定入口 + 密钥（与 Fabula 发布弹窗里的"直达链接"一致） */
    private static final String START_URL =
            "http://123.57.165.181:8080/fabula-board/s/3a4c5cebc858018aad81acd885d0e5dd/";

    private static final int REQ_FILE = 1001;

    private WebView web;
    private ValueCallback<Uri[]> fileCb;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        web.setWebViewClient(new WebViewClient());

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCb != null) {
                    fileCb.onReceiveValue(null);
                }
                fileCb = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("image/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "选择图片"), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCb = null;
                    return false;
                }
            }
        });

        setContentView(web);
        web.loadUrl(START_URL);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getDataString() != null) {
                    result = new Uri[]{Uri.parse(data.getDataString())};
                } else if (data.getClipData() != null && data.getClipData().getItemCount() > 0) {
                    result = new Uri[]{data.getClipData().getItemAt(0).getUri()};
                }
            }
            if (fileCb != null) {
                fileCb.onReceiveValue(result);
                fileCb = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
