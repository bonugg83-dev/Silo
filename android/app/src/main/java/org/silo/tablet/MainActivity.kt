package org.silo.tablet

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * Silo 태블릿 앱 (가로 고정)
 *
 *   위쪽 줄 ─ 뒤로, 새로고침, 열린 창(마이픽 / 편집 화면 151쪽 ×), 패널 접기
 *   왼쪽     ─ 마이픽 사이트. 사이트가 여는 창(편집 화면 등)은 따로 뜨지 않고 왼쪽 칸에 겹쳐 열림
 *   오른쪽   ─ Silo 패널 (app/sidepanel.html, 모든 플랫폼이 같이 쓰는 앱 코드)
 *   로그인 화면·시작 모션 동안은 패널이 화면 전체
 *
 * 앱 코드는 플랫폼 창구(window.siloPlatform, res/raw/silo_platform.js)로만 부탁하고, 실제 일은 이 파일이 한다.
 */
class MainActivity : Activity() {
    companion object {
        const val HOME = "https://www.mypickebook.org/"
        const val APP_ORIGIN = "https://appassets.androidplatform.net"
        const val PANEL_URL = "$APP_ORIGIN/assets/sidepanel.html"
        const val SITE_ID = 1
        const val TAG = "Silo"
        @Volatile var firstLoadDone = false
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var store: Store
    private lateinit var root: LinearLayout
    private lateinit var topBar: LinearLayout
    private lateinit var strip: LinearLayout
    private lateinit var siteArea: FrameLayout
    private lateinit var divider: View
    private lateinit var panel: WebView
    private lateinit var togglePanel: TextView

    /** 탭 = 마이픽 사이트(1번)와 사이트가 연 창들 */
    private val tabs = LinkedHashMap<Int, WebView>()
    private var nextTabId = 2
    private var shownPopup: Int? = null

    // 화면 배치
    private var booting = true      // 패널이 배치를 알려 오기 전: 패널(검정)만 화면 전체
    private var authOpen = false
    private var splashOpen = false
    private var panelHidden = false
    @Volatile private var dockShift = "{\"dx\":0,\"dy\":0}"

    private val dp get() = resources.displayMetrics.density
    private fun px(v: Int) = (v * dp).toInt()

    // ---------------------------------------------------------------- 화면 만들기
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(filesDir)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.BLACK) }
        topBar = buildTopBar()
        val content = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        siteArea = FrameLayout(this).apply { setBackgroundColor(Color.WHITE) }
        divider = View(this).apply { setBackgroundColor(Color.parseColor("#2c2c2c")) }
        panel = buildPanel()
        content.addView(siteArea, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        content.addView(divider, LinearLayout.LayoutParams(px(1), ViewGroup.LayoutParams.MATCH_PARENT))
        content.addView(panel, LinearLayout.LayoutParams(px(400), ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(topBar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(48)))
        root.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)

        val site = newSiteView()
        tabs[SITE_ID] = site
        siteArea.addView(site, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> updateDockShift() }
        applyLayout()
        main.postDelayed({ if (booting) { booting = false; applyLayout() } }, 6000) // 패널이 끝내 알려 오지 않아도
        panel.loadUrl(PANEL_URL)
        site.loadUrl(HOME)
    }

    private fun pill(text: String, onClick: () -> Unit) = TextView(this).apply {
        this.text = text
        setTextColor(Color.parseColor("#f1f1f1"))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        gravity = Gravity.CENTER
        minWidth = px(44)
        setPadding(px(12), 0, px(12), 0)
        background = GradientDrawable().apply { cornerRadius = px(10).toFloat(); setColor(Color.parseColor("#1c1c1c")) }
        isClickable = true
        setOnClickListener { onClick() }
    }

    private fun buildTopBar(): LinearLayout {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.parseColor("#0b0b0b"))
            setPadding(px(8), px(4), px(8), px(4))
        }
        val lp = { LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT).apply { marginEnd = px(6) } }
        bar.addView(pill("◀") { goBack() }.apply { contentDescription = "뒤로" }, lp())
        bar.addView(pill("⟳") { current().reload() }.apply { contentDescription = "새로고침" }, lp())
        strip = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val scroll = HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(strip) }
        bar.addView(scroll, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        togglePanel = pill("패널 접기") { panelHidden = !panelHidden; applyLayout() }
        bar.addView(togglePanel, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT))
        return bar
    }

    /** 위쪽 줄의 열린 창 목록: 마이픽 / 편집 화면 151쪽 × */
    private fun renderStrip() {
        strip.removeAllViews()
        for ((id, web) in tabs) {
            val on = (shownPopup ?: SITE_ID) == id
            val label = if (id == SITE_ID) "마이픽" else popupTitle(web)
            val chip = pill(label) { showTab(id) }.apply {
                (background as GradientDrawable).setColor(Color.parseColor(if (on) "#2c2c2c" else "#151515"))
                setTextColor(Color.parseColor(if (on) "#f1f1f1" else "#9a9a9a"))
            }
            strip.addView(chip, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT).apply { marginEnd = px(4) })
            if (id != SITE_ID) {
                strip.addView(pill("×") { closeTab(id) }.apply { contentDescription = "$label 닫기" },
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT).apply { marginEnd = px(10) })
            }
        }
    }

    private fun popupTitle(web: WebView): String {
        val u = web.url ?: ""
        if (Regex("mypickebook\\.org/making/make_book\\.html").containsMatchIn(u)) {
            val n = Regex("[?&]book_page=(\\d+)").find(u)?.groupValues?.get(1)
            return if (n != null) "편집 화면 ${n}쪽" else "편집 화면"
        }
        val t = web.title ?: ""
        return if (t.isNotBlank() && !t.startsWith("http") && !t.startsWith("about:")) t.take(20) else "새 창"
    }

    // ---------------------------------------------------------------- 배치
    private fun applyLayout() {
        val full = booting || authOpen || splashOpen
        topBar.visibility = if (full) View.GONE else View.VISIBLE
        siteArea.visibility = if (full) View.GONE else View.VISIBLE
        divider.visibility = if (full || panelHidden) View.GONE else View.VISIBLE
        val lp = panel.layoutParams as LinearLayout.LayoutParams
        if (full) {
            panel.visibility = View.VISIBLE
            lp.width = 0; lp.weight = 1f
        } else {
            panel.visibility = if (panelHidden) View.GONE else View.VISIBLE
            lp.weight = 0f
            val w = (root.width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels)
            lp.width = (w * 0.34f).toInt().coerceIn(px(360), px(520))
        }
        panel.layoutParams = lp
        togglePanel.text = if (panelHidden) "패널 펴기" else "패널 접기"
        renderStrip()
        root.post { updateDockShift() }
    }

    /** 시작 모션이 끝나는 자리: 오른쪽 패널로 줄어든 뒤 패널 머리 로고 자리 (CSS 픽셀) */
    private fun updateDockShift() {
        val w = root.width.toFloat()
        if (w <= 0) return
        val pw = (w * 0.34f).coerceIn(px(360).toFloat(), px(520).toFloat())
        dockShift = JSONObject().put("dx", ((w - pw) / dp).toDouble()).put("dy", (px(48) / dp).toDouble()).toString()
    }

    // ---------------------------------------------------------------- 마이픽 사이트와 사이트가 연 창
    @SuppressLint("SetJavaScriptEnabled")
    private fun newSiteView(): WebView = WebView(this).apply {
        setBackgroundColor(Color.WHITE)
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.setSupportMultipleWindows(true)
        settings.javaScriptCanOpenWindowsAutomatically = true
        settings.useWideViewPort = true
        settings.loadWithOverviewMode = true
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
        settings.allowFileAccess = false
        // 마이픽이 모바일 화면으로 보내지 않게: PC 크롬처럼 (안드로이드·앱 표시 빼기)
        val chrome = Regex("Chrome/[\\d.]+").find(settings.userAgentString)?.value ?: "Chrome/131.0.0.0"
        settings.userAgentString = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) $chrome Safari/537.36"
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        webViewClient = SiteClient()
        webChromeClient = SiteChrome()
    }

    private fun idOf(web: WebView?): Int? = tabs.entries.firstOrNull { it.value === web }?.key

    private inner class SiteClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val s = request.url.scheme ?: ""
            if (s == "http" || s == "https" || s == "about" || s == "blob" || s == "data") return false
            try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) {}
            return true
        }
        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            val id = idOf(view) ?: return
            emitUpdated(id, JSONObject().put("status", "loading").put("url", url ?: ""))
        }
        override fun onPageFinished(view: WebView, url: String?) {
            val id = idOf(view) ?: return
            emitUpdated(id, JSONObject().put("status", "complete"))
            renderStrip()
        }
    }

    private inner class SiteChrome : WebChromeClient() {
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            val w = newSiteView()
            val id = nextTabId++
            tabs[id] = w
            siteArea.addView(w, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            (resultMsg.obj as WebView.WebViewTransport).webView = w
            resultMsg.sendToTarget()
            showTab(id)
            return true
        }
        override fun onCloseWindow(window: WebView) { idOf(window)?.let { closeTab(it) } }
        override fun onReceivedTitle(view: WebView, title: String?) { renderStrip() }
    }

    private fun current(): WebView = tabs[shownPopup ?: SITE_ID] ?: tabs[SITE_ID]!!

    private fun showTab(id: Int) {
        if (!tabs.containsKey(id)) return
        shownPopup = if (id == SITE_ID) null else id
        for ((tid, w) in tabs) w.visibility = if (tid == id) View.VISIBLE else View.INVISIBLE
        tabs[id]?.bringToFront()
        renderStrip()
        panelEmit("activated", JSONObject().put("tabId", id).put("windowId", id).toString())
    }

    private fun closeTab(id: Int) {
        if (id == SITE_ID) return
        val w = tabs.remove(id) ?: return
        siteArea.removeView(w)
        w.destroy()
        if (shownPopup == id) showTab(tabs.keys.lastOrNull() ?: SITE_ID) else renderStrip()
    }

    private fun goBack() {
        val w = current()
        when {
            w.canGoBack() -> w.goBack()
            shownPopup != null -> closeTab(shownPopup!!)
        }
    }

    @Deprecated("Activity.onBackPressed")
    override fun onBackPressed() {
        val w = current()
        if (!(booting || authOpen || splashOpen) && (w.canGoBack() || shownPopup != null)) goBack() else moveTaskToBack(true)
    }

    private fun tabInfo(id: Int): JSONObject? {
        val w = tabs[id] ?: return null
        return JSONObject().put("id", id).put("url", w.url ?: "").put("title", w.title ?: "")
            .put("status", if (w.progress < 100) "loading" else "complete")
            .put("active", (shownPopup ?: SITE_ID) == id).put("windowId", id)
    }

    private fun emitUpdated(id: Int, change: JSONObject) {
        val info = tabInfo(id) ?: return
        if (change.has("url")) info.put("url", change.getString("url"))
        panelEmit("updated", id.toString(), change.toString(), info.toString())
    }

    /** Silo 계정이 바뀌면 앞사람의 마이픽 로그인(쿠키)을 지우고 사이트를 처음부터 (태블릿은 쿠키가 하나뿐) */
    private fun onProfileChanged() {
        for (id in tabs.keys.filter { it != SITE_ID }) closeTab(id)
        CookieManager.getInstance().removeAllCookies {
            CookieManager.getInstance().flush()
            tabs[SITE_ID]?.apply { clearHistory(); loadUrl(HOME) }
        }
    }

    // ---------------------------------------------------------------- Silo 패널
    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun buildPanel(): WebView {
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        val web = WebView(this)
        web.setBackgroundColor(Color.BLACK)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        web.settings.mediaPlaybackRequiresUserGesture = true
        web.addJavascriptInterface(Bridge(), "SiloNative")
        val script = resources.openRawResource(R.raw.silo_platform).bufferedReader().use { it.readText() }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, script, setOf(APP_ORIGIN))
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.toString().startsWith(APP_ORIGIN)) return false
                try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) {}
                return true
            }
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                // 오래된 웹뷰라 문서 시작 스크립트가 안 되면 여기서라도 (조금 늦을 수 있음)
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) view.evaluateJavascript(script, null)
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                Log.d(TAG, "panel: ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
        return web
    }

    private fun panelEmit(name: String, vararg jsonArgs: String) {
        val js = "window.__siloNative&&window.__siloNative.emit(${JSONObject.quote(name)}${jsonArgs.joinToString("") { ",$it" }})"
        main.post { panel.evaluateJavascript(js, null) }
    }

    private fun resolve(id: String, json: String) {
        main.post { panel.evaluateJavascript("window.__siloNative&&window.__siloNative.resolve(${JSONObject.quote(id)},true,$json)", null) }
    }

    private fun reject(id: String, message: String) {
        main.post { panel.evaluateJavascript("window.__siloNative&&window.__siloNative.resolve(${JSONObject.quote(id)},false,${JSONObject.quote(message)})", null) }
    }

    /** 패널의 플랫폼 창구(silo_platform.js)가 부르는 다리 */
    private inner class Bridge {
        @JavascriptInterface
        fun call(id: String, method: String, argsJson: String) {
            main.post {
                try { handle(id, method, JSONArray(argsJson)) } catch (e: Exception) { reject(id, e.message ?: e.toString()) }
            }
        }
        @JavascriptInterface
        fun firstLoad(): Boolean { val first = !firstLoadDone; firstLoadDone = true; return first }
        @JavascriptInterface
        fun dockShift(): String = this@MainActivity.dockShift
        @JavascriptInterface
        fun layoutMode(json: String) {
            main.post {
                val m = try { JSONObject(json) } catch (_: Exception) { return@post }
                booting = false
                authOpen = m.optBoolean("auth")
                splashOpen = m.optBoolean("splash")
                applyLayout()
            }
        }
    }

    private fun handle(id: String, method: String, a: JSONArray) {
        when (method) {
            "storage.get" -> resolve(id, store.get(a.getString(0), a.opt(1)).toString())
            "storage.set" -> {
                val area = a.getString(0)
                val items = a.getJSONObject(1)
                val before = store.localString("activeProfileId")
                val changes = store.set(area, items)
                resolve(id, "null")
                if (changes.length() > 0) panelEmit("storage", changes.toString(), JSONObject.quote(area))
                if (area == "local" && items.has("activeProfileId")) {
                    val after = store.localString("activeProfileId")
                    if (before.isNotEmpty() && after != before) onProfileChanged()
                }
            }
            "storage.remove" -> {
                val area = a.getString(0)
                val changes = store.remove(area, a.opt(1))
                resolve(id, "null")
                if (changes.length() > 0) panelEmit("storage", changes.toString(), JSONObject.quote(area))
            }
            "storage.clear" -> {
                val area = a.getString(0)
                val changes = store.clear(area)
                resolve(id, "null")
                if (changes.length() > 0) panelEmit("storage", changes.toString(), JSONObject.quote(area))
            }
            "tabs.query" -> {
                val q = a.optJSONObject(0) ?: JSONObject()
                val out = JSONArray()
                for (tid in tabs.keys) {
                    val info = tabInfo(tid) ?: continue
                    if (q.has("active") && q.optBoolean("active") != info.optBoolean("active")) continue
                    out.put(info)
                }
                resolve(id, out.toString())
            }
            "tabs.get" -> tabInfo(a.optInt(0))?.let { resolve(id, it.toString()) } ?: reject(id, "No tab with id: ${a.opt(0)}.")
            "tabs.update" -> {
                val tid = a.optInt(0)
                if (a.optJSONObject(1)?.optBoolean("active") == true) showTab(tid)
                tabInfo(tid)?.let { resolve(id, it.toString()) } ?: reject(id, "No tab with id: $tid.")
            }
            "tabs.create" -> {
                Toast.makeText(this, "태블릿에서는 다음 버전부터 테스트 화면을 쓸 수 있어요.", Toast.LENGTH_LONG).show()
                reject(id, "태블릿에서는 다음 버전부터 테스트 화면을 쓸 수 있어요.")
            }
            "scripting.exec" -> runInSite(id, a.optInt(0), a.getString(1), a.optJSONArray(2) ?: JSONArray())
            else -> reject(id, "모르는 기능: $method")
        }
    }

    // ---------------------------------------------------------------- 편집 화면에서 함수 실행
    private var execSeq = 0

    /**
     * 사이트 쪽에서 app/lib/page.js 의 함수를 실행한다. 바로 끝나는 함수(넣기, 저장)는 곧바로 답하고,
     * 기다려야 하는 함수(이미지 가져오기, 올리기)는 결과를 그 페이지에 적어 두게 하고 0.1초마다 확인한다
     * (안드로이드 웹뷰는 Promise를 기다려 주지 않음).
     */
    private fun runInSite(id: String, tabId: Int, src: String, args: JSONArray) {
        val web = tabs[tabId] ?: return reject(id, "No tab with id: $tabId.")
        val token = JSONObject.quote("silo${++execSeq}")
        val js = "(function(){var T=$token;window.__siloRes=window.__siloRes||{};" +
            "function done(o){window.__siloRes[T]=JSON.stringify(o);}" +
            "try{var r=($src).apply(null,$args);" +
            "if(r&&typeof r.then==='function'){r.then(function(v){done({ok:true,result:v===undefined?null:v});}," +
            "function(e){done({ok:false,error:String(e&&e.message||e)});});return 'PENDING';}" +
            "return JSON.stringify({ok:true,result:r===undefined?null:r});" +
            "}catch(e){return JSON.stringify({ok:false,error:String(e&&e.message||e)});}})()"
        web.evaluateJavascript(js) { raw -> takeResult(id, web, token, raw, System.currentTimeMillis()) }
    }

    private fun takeResult(id: String, web: WebView, token: String, raw: String?, started: Long) {
        val s = try { JSONTokener(raw ?: "null").nextValue() } catch (_: Exception) { null }
        if (s is String && s != "PENDING") {
            val o = try { JSONObject(s) } catch (e: Exception) { return reject(id, "편집 화면의 답을 읽지 못했어요.") }
            if (!o.optBoolean("ok")) return reject(id, o.optString("error", "편집 화면에서 오류가 났어요."))
            val v = o.opt("result")
            val text = when (v) {
                null, JSONObject.NULL -> "null"
                is JSONObject, is JSONArray -> v.toString()
                is String -> JSONObject.quote(v)
                else -> v.toString()
            }
            return resolve(id, text)
        }
        if (System.currentTimeMillis() - started > 180_000 || idOf(web) == null) return reject(id, "편집 화면에서 답이 없어요.")
        main.postDelayed({
            if (idOf(web) == null) return@postDelayed reject(id, "편집 화면이 닫혔어요.")
            web.evaluateJavascript("(function(){var m=window.__siloRes||{};var r=m[$token];if(r!==undefined){delete m[$token];return r;}return null;})()") {
                takeResult(id, web, token, it, started)
            }
        }, 100)
    }

    // ---------------------------------------------------------------- 수명
    override fun onPause() {
        super.onPause()
        store.flush()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        for (w in tabs.values) w.destroy()
        panel.destroy()
        super.onDestroy()
    }

    @Suppress("unused")
    private fun openExternal(url: String) = try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) {}
}
