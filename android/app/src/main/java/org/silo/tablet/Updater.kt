package org.silo.tablet

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * 태블릿 자동 업데이트
 *
 * GitHub의 최신 릴리스(데스크톱과 같은 릴리스)에 지금보다 새 버전의 Silo-<버전>.apk 가 있으면 뒤에서 받아 둔다.
 * 다 받으면 onReady(버전)을 부른다 → 위쪽 줄에 "새 버전 x · 설치" 버튼. 설치는 안드로이드 설치 화면에서 한 번 누름.
 * 같은 서명 키로 만든 APK라 덮어 설치되고 기록은 남는다.
 */
class Updater(private val ctx: Context, private val currentVersion: String, private val onReady: (String) -> Unit) {
    companion object {
        const val LATEST = "https://api.github.com/repos/bonugg83-dev/Silo/releases/latest"
        const val TAG = "SiloUpdate"

        /** "0.4.10" > "0.4.9" 처럼 숫자로 비교 */
        fun isNewer(a: String, b: String): Boolean {
            val x = a.split(".").map { it.toIntOrNull() ?: 0 }
            val y = b.split(".").map { it.toIntOrNull() ?: 0 }
            for (i in 0 until maxOf(x.size, y.size)) {
                val d = x.getOrElse(i) { 0 } - y.getOrElse(i) { 0 }
                if (d != 0) return d > 0
            }
            return false
        }
    }

    private val io = Executors.newSingleThreadExecutor()
    @Volatile var ready: File? = null
        private set
    @Volatile var readyVersion = ""
        private set

    fun check() = io.execute {
        if (ready != null) return@execute
        try { run() } catch (e: Exception) { Log.w(TAG, "업데이트 확인 실패: ${e.message}") }
    }

    private fun get(url: String): HttpURLConnection = (URL(url).openConnection() as HttpURLConnection).apply {
        connectTimeout = 15000
        readTimeout = 60000
        instanceFollowRedirects = true
        setRequestProperty("Accept", "application/vnd.github+json")
        setRequestProperty("User-Agent", "Silo-Tablet")
    }

    private fun run() {
        val rel = get(LATEST).let { c -> c.inputStream.bufferedReader().use { JSONObject(it.readText()) }.also { c.disconnect() } }
        val v = rel.optString("tag_name").removePrefix("v")
        if (!isNewer(v, currentVersion)) return
        val assets = rel.optJSONArray("assets") ?: return
        val asset = (0 until assets.length()).map { assets.getJSONObject(it) }.firstOrNull { it.optString("name") == "Silo-$v.apk" } ?: return
        val size = asset.optLong("size")
        val dir = File(ctx.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.filter { it.name != "Silo-$v.apk" }?.forEach { it.delete() } // 예전에 받은 것 정리
        val file = File(dir, "Silo-$v.apk")
        if (!(file.exists() && file.length() == size)) {
            val tmp = File(dir, "Silo-$v.apk.part")
            val c = get(asset.getString("browser_download_url"))
            c.setRequestProperty("Accept", "application/octet-stream")
            c.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
            c.disconnect()
            if (size > 0 && tmp.length() != size) { tmp.delete(); return }
            tmp.renameTo(file)
        }
        // 받은 파일이 정말 그 버전의 Silo 인지
        val info = ctx.packageManager.getPackageArchiveInfo(file.path, 0)
        if (info?.packageName != ctx.packageName || info.versionName != v) { file.delete(); return }
        ready = file
        readyVersion = v
        onReady(v)
    }
}
