package com.moshforge.studio

import android.net.Uri
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

class MainActivity : ComponentActivity() {

    private var fileCallback: ValueCallback<Array<Uri>>? = null

    // Without onShowFileChooser, <input type="file"> silently does nothing —
    // the most common "app is dead on my phone" bug in WebView shells.
    private val filePicker =
        registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            fileCallback?.onReceiveValue(uris.toTypedArray())
            fileCallback = null
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = true
        web.webViewClient = WebViewClient()
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                fileCallback = callback
                filePicker.launch(arrayOf("*/*"))
                return true
            }
        }
        // fetch()/XHR to file: URLs is blocked in WebViews — bundle sidecar JS
        // via relative <script src> tags; embed binaries (e.g. WASM) as base64 in JS.
        web.loadUrl("file:///android_asset/www/index.html")
        setContentView(web)
    }
}
