package com.twkim.videiomusic

import android.Manifest
import android.app.PendingIntent
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.graphics.drawable.Icon
import androidx.core.content.ContextCompat
import android.app.PictureInPictureParams
import android.content.res.Configuration
import android.util.Rational
import android.app.DownloadManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.View
import android.webkit.*
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.twkim.videiomusic.data.LibraryPreferencesStore
import com.twkim.videiomusic.data.ProfileStore
import com.twkim.videiomusic.data.ServerProfile
import com.twkim.videiomusic.playback.NativePlaybackBridge
import com.twkim.videiomusic.web.BundledWebPolicy
import com.twkim.videiomusic.web.WebFullscreenWindow
import com.twkim.videiomusic.web.WebWindowState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/** Native host only: all app screens are the current React build packaged in assets. */
class MainActivity : ComponentActivity() {
    private lateinit var root: FrameLayout
    private var web: WebView? = null
    private var playback: NativePlaybackBridge? = null
    private var reply: JavaScriptReplyProxy? = null
    private var profile = ServerProfile()
    private var origin = BundledWebPolicy.SETUP_ORIGIN
    private val pipControlAction get() = "$packageName.VIDEO_PIP_CONTROL"
    private val pipControlReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != pipControlAction || !isInPictureInPictureMode || setup) return
            val command = intent.getStringExtra("command")
            if (command != "play" && command != "pause") return
            // PiP is paused at the Activity level. Resume the WebView before
            // delivering controls, and never route them through the music session.
            web?.onResume()
            web?.evaluateJavascript("window.dispatchEvent(new CustomEvent('muzio-video-control',{detail:'$command'}));", null)
        }
    }
    private var videoPlaying = false
    private var videoAspect = Rational(16, 9)
    private var setup = true
    private var fullScreenView: View? = null
    private var fullScreenCallback: WebChromeClient.CustomViewCallback? = null
    private val fullscreenWindow by lazy {
        WebFullscreenWindow(capture = {
            val insets = ViewCompat.getRootWindowInsets(root)
            WebWindowState(
                requestedOrientation,
                WindowInsetsControllerCompat(window, root).systemBarsBehavior,
                insets?.isVisible(WindowInsetsCompat.Type.statusBars()) ?: true,
                insets?.isVisible(WindowInsetsCompat.Type.navigationBars()) ?: true,
                if (Build.VERSION.SDK_INT >= 28) window.attributes.layoutInDisplayCutoutMode else 0,
            )
        }, apply = { state ->
            if (requestedOrientation != state.orientation) requestedOrientation = state.orientation
            if (Build.VERSION.SDK_INT >= 28) {
                window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = state.cutoutMode }
            }
            WindowInsetsControllerCompat(window, root).apply {
                systemBarsBehavior = state.barsBehavior
                if (state.statusBarVisible) show(WindowInsetsCompat.Type.statusBars()) else hide(WindowInsetsCompat.Type.statusBars())
                if (state.navigationBarVisible) show(WindowInsetsCompat.Type.navigationBars()) else hide(WindowInsetsCompat.Type.navigationBars())
            }
            ViewCompat.requestApplyInsets(root)
        })
    }
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val localLibrary by lazy { com.twkim.videiomusic.data.LocalLibraryManager(applicationContext) }
    private val videoIndex by lazy { com.twkim.videiomusic.web.VideoIndexInterceptor(com.twkim.videiomusic.web.VideoIndexCache(java.io.File(cacheDir, "video-index-v1"))) }
    private var folderReply: ((Result<JSONObject>) -> Unit)? = null
    private var folderPickerOpen = false
    private val folderPicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        folderPickerOpen = false
        val respond = folderReply
        folderReply = null
        lifecycleScope.launch {
            val snapshot = runCatching {
                val uri = result.data?.data.takeIf { result.resultCode == RESULT_OK }
                if (uri == null) localLibrary.list() else localLibrary.add(uri)
            }
            respond?.invoke(snapshot)
        }
    }
    private val permission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
    private val filePicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        fileCallback = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ContextCompat.registerReceiver(this, pipControlReceiver, IntentFilter(pipControlAction), ContextCompat.RECEIVER_NOT_EXPORTED)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT), navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(31, 31, 31)) }
        // Web viewport excludes OS bars and keyboard, preserving the web layout's
        // fixed/floating positioning without duplicating CSS safe-area padding.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            if (isInPictureInPictureMode || fullScreenView != null) view.setPadding(0, 0, 0, 0)
            else view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(root)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (fullScreenView != null) { hideFullScreen(); return }
                val current = web ?: return moveToBackground()
                current.evaluateJavascript("(function(){var e=new Event('muzio-back',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;})()") { handled ->
                    if (handled != "true") {
                        if (setup && profile.baseUrl.isNotBlank()) showWeb(false)
                        else if (current.canGoBack()) current.goBack()
                        else moveToBackground()
                    }
                }
            }
        })
        lifecycleScope.launch {
            profile = ProfileStore(applicationContext).profile.first()
            val valid = runCatching { BundledWebPolicy.serverOrigin(profile.baseUrl) }.getOrNull()
            // Older profiles allowed malformed URLs. Keep the stored original
            // recoverable but do not let it prevent saving a valid replacement.
            profile = profile.copy(baseUrl = valid.orEmpty())
            showWeb(valid == null)
        }
    }

    @Suppress("SetJavaScriptEnabled")
    private fun showWeb(showSetup: Boolean) {
        videoPlaying = false
        updatePipParams()
        hideFullScreen()
        reply = null
        playback?.dispose()
        playback = null
        web?.let { root.removeView(it); it.destroy() }
        setup = showSetup
        origin = if (showSetup) BundledWebPolicy.SETUP_ORIGIN else profile.baseUrl
        val pageOrigin = origin
        val view = WebView(this)
        web = view
        root.addView(view, FrameLayout.LayoutParams(-1, -1))
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            root.removeView(view)
            root.addView(TextView(this).apply { text = "Android System WebView를 업데이트한 다음 Muzio를 다시 열어주세요."; setTextColor(Color.WHITE); setPadding(32, 80, 32, 32) })
            return
        }
        view.setBackgroundColor(Color.rgb(31, 31, 31))
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(true)
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        // Only exact trusted origin + top frame receive commands. External
        // documents never replace the bundled app inside this WebView.
        WebViewCompat.addWebMessageListener(view, "MuzioNative", setOf(pageOrigin)) { _, message, sourceOrigin, mainFrame, proxy ->
            if (!mainFrame || !BundledWebPolicy.sameOrigin(sourceOrigin.toString(), pageOrigin) || web !== view) return@addWebMessageListener
            reply = proxy
            val request = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return@addWebMessageListener
            val id = request.optString("id")
            val command = request.optString("command")
            val payload = request.optJSONObject("payload") ?: JSONObject()
            fun respond(result: Result<JSONObject>) {
                if (web !== view) return
                val response = JSONObject().put("type", "response").put("id", id).put("ok", result.isSuccess)
                result.fold({ response.put("result", it) }, { response.put("error", it.message ?: "요청을 처리하지 못했습니다.") })
                proxy.postMessage(response.toString())
            }
            if (command.startsWith("playback.") && !setup) {
                if (playback == null) playback = NativePlaybackBridge(applicationContext, pageOrigin) { event ->
                    if (web === view) reply?.postMessage(event.toString())
                }
                if (command == "playback.play" && Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
                playback!!.handle(command, payload, ::respond)
            } else handleShell(command, payload, ::respond)
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url.toString()
                if (!BundledWebPolicy.sameOrigin(url, pageOrigin)) return null
                if (request.url.path.orEmpty().startsWith("/__muzio_local/artwork/")) {
                    if (request.isForMainFrame || request.method != "GET" || showSetup) return emptyResponse(403, "Forbidden")
                    return runCatching {
                        val id = request.url.path.orEmpty().removePrefix("/__muzio_local/artwork/")
                        val stream = localLibrary.openArtwork(id) ?: return emptyResponse(404, "Not Found")
                        WebResourceResponse("image/jpeg", null, 200, "OK",
                            mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"), stream)
                    }.getOrElse { emptyResponse(404, "Not Found") }
                }
                // Never load server-provided HTML as an app screen, including
                // after redirect; APIs/media retain their actual network path.
                val asset = BundledWebPolicy.assetPath(url, pageOrigin)
                if (asset != null) {
                    return runCatching {
                        val stream = assets.open("muzio-web/$asset")
                        val mime = when (asset.substringAfterLast('.', "")) {
                            "html" -> "text/html"
                            "js", "mjs" -> "application/javascript"
                            "css" -> "text/css"
                            "json", "webmanifest" -> "application/json"
                            "svg" -> "image/svg+xml"
                            "woff2" -> "font/woff2"
                            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(asset.substringAfterLast('.')) ?: "application/octet-stream"
                        }
                        WebResourceResponse(mime, "UTF-8", 200, "OK", mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"), stream)
                    }.getOrElse { emptyResponse(404, "Not Found") }
                }
                if (request.isForMainFrame || showSetup) return emptyResponse(403, "Forbidden")
                if (request.method == "GET") {
                    val headers = request.requestHeaders.toMutableMap()
                    CookieManager.getInstance().getCookie(url)?.let { headers["Cookie"] = it }
                    videoIndex.intercept(url, pageOrigin, headers)?.let { cached ->
                        return WebResourceResponse(cached.mime, null, cached.status,
                            if (cached.status == 206) "Partial Content" else "OK", cached.headers, cached.stream)
                    }
                }
                return null
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                val uri = request.url
                if (BundledWebPolicy.sameOrigin(uri.toString(), pageOrigin) && BundledWebPolicy.isAppRoute(uri.path.orEmpty())) return false
                openExternal(uri)
                return true
            }
            override fun onPageFinished(view: WebView, url: String) {
                // A data-less startup screen is bundled too; no server is needed
                // to recover a disconnected profile or read cached library UI.
                view.evaluateJavascript("window.dispatchEvent(new Event('muzio-resume'));", null)
            }
            override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: android.net.http.SslError) {
                handler.cancel()
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return runCatching { filePicker.launch(params.createIntent()); true }.getOrElse { fileCallback = null; false }
            }
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
                if (!isUserGesture) return false
                val popup = WebView(this@MainActivity)
                popup.webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        openExternal(request.url); view.destroy(); return true
                    }
                }
                (resultMsg.obj as WebView.WebViewTransport).webView = popup
                resultMsg.sendToTarget()
                return true
            }
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                if (fullScreenView != null) { callback.onCustomViewHidden(); return }
                fullScreenView = view; fullScreenCallback = callback
                web?.visibility = View.GONE
                root.addView(view, FrameLayout.LayoutParams(-1, -1))
                root.setPadding(0, 0, 0, 0)
                fullscreenWindow.enter(isInPictureInPictureMode)
                ViewCompat.requestApplyInsets(root)
            }
            override fun onHideCustomView() = hideFullScreen()
        }
        view.setDownloadListener { url, agent, disposition, mime, _ ->
            if (!BundledWebPolicy.sameOrigin(url, pageOrigin)) return@setDownloadListener
            runCatching {
                val request = DownloadManager.Request(Uri.parse(url))
                    .setMimeType(mime).addRequestHeader("User-Agent", agent)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, URLUtil.guessFileName(url, disposition, mime))
                CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
                (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
            }
        }
        view.loadUrl("$pageOrigin/")
    }

    private fun handleShell(command: String, payload: JSONObject, respond: (Result<JSONObject>) -> Unit) {
        if (command == "localLibrary.add") {
            if (folderPickerOpen) { respond(Result.failure(IllegalStateException("Folder picker is already open"))); return }
            folderPickerOpen = true
            folderReply = respond
            runCatching {
                folderPicker.launch(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).putExtra(Intent.EXTRA_LOCAL_ONLY, true).addFlags(
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION))
            }.onFailure { folderPickerOpen = false; folderReply = null; respond(Result.failure(it)) }
            return
        }
        val requestingView = web
        lifecycleScope.launch {
            val result = runCatching {
                when (command) {
                    "localLibrary.list" -> localLibrary.list()
                    "localLibrary.refresh" -> localLibrary.refresh()
                    "localLibrary.remove" -> localLibrary.remove(payload.getString("id"))
                    "shell.videoState" -> {
                        videoPlaying = !setup && payload.optBoolean("playing", false)
                        val width = payload.optInt("width", 16)
                        val height = payload.optInt("height", 9)
                        videoAspect = if (width > 0 && height > 0 && width.toDouble() / height in (1.0 / 2.39)..2.39) Rational(width, height) else Rational(16, 9)
                        updatePipParams()
                        JSONObject()
                    }
                    "shell.notificationIntent" -> {
                        val openQueue = intent?.getBooleanExtra("muzio.open_queue", false) == true
                        if (payload.optBoolean("acknowledged", false)) intent?.removeExtra("muzio.open_queue")
                        JSONObject().put("openQueue", openQueue)
                    }
                    "shell.profile" -> JSONObject().put("baseUrl", profile.baseUrl).put("displayName", profile.displayName).put("setup", setup)
                    "shell.connect" -> {
                        val next = BundledWebPolicy.serverOrigin(payload.getString("baseUrl"))
                        withContext(Dispatchers.IO) { checkServer(next) }
                        check(web === requestingView) { "서버 연결이 취소되었습니다." }
                        // Old playback must never move to another server's API.
                        if (next != profile.baseUrl && profile.baseUrl.isNotBlank()) {
                            val old = NativePlaybackBridge(applicationContext, profile.baseUrl) {}
                            kotlinx.coroutines.suspendCancellableCoroutine<Unit> { continuation ->
                                old.handle("playback.clear", JSONObject()) { cleared ->
                                    old.dispose()
                                    if (continuation.isActive) cleared.fold({ continuation.resumeWith(Result.success(Unit)) }, { continuation.resumeWith(Result.failure(it)) })
                                }
                                continuation.invokeOnCancellation { old.dispose() }
                            }
                        }
                        check(web === requestingView) { "서버 연결이 취소되었습니다." }
                        profile = profile.copy(baseUrl = next)
                        ProfileStore(applicationContext).save(profile)
                        JSONObject()
                    }
                    "shell.editServer", "shell.cancelSetup" -> JSONObject()
                    "shell.legacyPreferences" -> {
                        val migrated = getSharedPreferences("shared_web_migration", MODE_PRIVATE).getBoolean("complete", false)
                        JSONObject().put("values", if (migrated || setup) JSONObject() else LibraryPreferencesStore(applicationContext).exportWebPreferences())
                    }
                    "shell.finishMigration" -> {
                        require(!setup)
                        check(getSharedPreferences("shared_web_migration", MODE_PRIVATE).edit().putBoolean("complete", true).commit())
                        JSONObject()
                    }
                    "shell.background" -> { moveToBackground(); JSONObject() }
                    "shell.appearance" -> {
                        val color = Color.parseColor(payload.getString("backgroundColor"))
                        root.setBackgroundColor(color)
                        val lightIcons = payload.getBoolean("dark")
                        WindowInsetsControllerCompat(window, root).apply {
                            isAppearanceLightStatusBars = !lightIcons
                            isAppearanceLightNavigationBars = !lightIcons
                        }
                        JSONObject()
                    }
                    else -> error("지원하지 않는 앱 요청입니다: $command")
                }
            }
            respond(result)
            if (result.isSuccess) when (command) {
                "shell.connect", "shell.cancelSetup" -> if (profile.baseUrl.isNotBlank()) web?.post { showWeb(false) }
                "shell.editServer" -> web?.post { showWeb(true) }
            }
        }
    }

    private fun checkServer(base: String) {
        val connection = URL("$base/healthz").openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 7_000; connection.readTimeout = 7_000
            connection.instanceFollowRedirects = false
            require(connection.responseCode == 200) { "서버에 연결할 수 없습니다 (HTTP ${connection.responseCode})." }
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            require(json.optString("status") == "ok" && json.optString("service") == "muzio-backend") { "Muzio 서버 주소인지 확인하세요." }
        } finally { connection.disconnect() }
    }

    private fun emptyResponse(status: Int, reason: String) = WebResourceResponse("text/plain", "UTF-8", status, reason,
        mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(ByteArray(0)))

    private fun openExternal(uri: Uri) {
        if (uri.scheme !in listOf("http", "https", "mailto")) return
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)) }
    }

    private fun hideFullScreen() {
        if (fullScreenView == null) return
        fullScreenView?.let { root.removeView(it) }
        fullScreenView = null
        val callback = fullScreenCallback
        fullScreenCallback = null
        web?.visibility = View.VISIBLE
        fullscreenWindow.exit()
        callback?.onCustomViewHidden()
    }

    private fun supportsPip() = packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private fun pipParams(): PictureInPictureParams = PictureInPictureParams.Builder().apply {
        setAspectRatio(videoAspect)
        // Explicit actions override controls from the independent audio session.
        val command = if (videoPlaying) "pause" else "play"
        val label = if (videoPlaying) "Pause" else "Play"
        val icon = if (videoPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
        val pending = PendingIntent.getBroadcast(this@MainActivity, if (videoPlaying) 1 else 2,
            Intent(pipControlAction).setPackage(packageName).putExtra("command", command),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        setActions(listOf(RemoteAction(Icon.createWithResource(this@MainActivity, icon), label, label, pending)))
        if (Build.VERSION.SDK_INT >= 31) setAutoEnterEnabled(videoPlaying && !setup)
    }.build()

    private fun updatePipParams() {
        if (supportsPip()) runCatching { setPictureInPictureParams(pipParams()) }
    }

    private fun enterVideoPip(): Boolean {
        if (!videoPlaying || setup || !supportsPip()) return false
        return isInPictureInPictureMode || runCatching { enterPictureInPictureMode(pipParams()) }.getOrDefault(false)
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        // Android 12+ handles gesture navigation with auto-enter parameters.
        if (Build.VERSION.SDK_INT < 31) enterVideoPip()
    }

    override fun onPictureInPictureModeChanged(inPip: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(inPip, newConfig)
        web?.evaluateJavascript("window.dispatchEvent(new CustomEvent('muzio-pip',{detail:$inPip}));", null)
        fullscreenWindow.refresh(inPip)
        ViewCompat.requestApplyInsets(root)
        if (inPip) web?.onResume()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && fullScreenView != null) fullscreenWindow.refresh(isInPictureInPictureMode)
    }

    private fun moveToBackground() { if (!enterVideoPip()) moveTaskToBack(true) }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        web?.evaluateJavascript("window.dispatchEvent(new Event('muzio-resume'));", null)
    }

    override fun onResume() {
        super.onResume()
        web?.onResume()
        web?.evaluateJavascript("window.dispatchEvent(new Event('muzio-resume'));", null)
    }

    override fun onPause() {
        // A PiP Activity is paused but its visible video must keep rendering.
        if (!isInPictureInPictureMode && !videoPlaying) web?.onPause()
        super.onPause()
    }

    override fun onStop() {
        super.onStop()
        // Visible PiP does not stop the Activity. Closing PiP does, even if
        // the mode flag has not yet changed, so stop web video unconditionally.
        web?.evaluateJavascript("window.dispatchEvent(new Event('muzio-video-stop'));", null)
        web?.onPause()
    }

    override fun onDestroy() {
        unregisterReceiver(pipControlReceiver)
        reply = null
        hideFullScreen()
        playback?.dispose()
        fileCallback?.onReceiveValue(null)
        web?.let { root.removeView(it); it.destroy() }
        web = null
        super.onDestroy()
    }
}
