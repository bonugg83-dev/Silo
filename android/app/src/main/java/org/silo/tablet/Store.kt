package org.silo.tablet

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * 플랫폼 창구 storage.local / storage.session (app/lib/platform.js).
 * local: 앱 데이터 폴더의 storage.json (이 기기에 계속 남음). session: 메모리 (앱을 닫으면 사라짐, 풀린 API 키는 여기에만).
 * get/set/remove 는 크롬 확장 storage API와 같은 규칙: get(null)=전부, get("키"), get(["키",…]), get({키: 기본값}).
 */
class Store(dir: File) {
    private val file = File(dir, "storage.json")
    private val local: JSONObject = try { JSONObject(file.readText()) } catch (_: Exception) { JSONObject() }
    private val session = JSONObject()
    private val io = Executors.newSingleThreadScheduledExecutor()
    private var pending: ScheduledFuture<*>? = null

    private fun area(name: String) = if (name == "session") session else local

    fun get(name: String, keys: Any?): JSONObject {
        val a = area(name)
        val out = JSONObject()
        when (keys) {
            null, JSONObject.NULL -> a.keys().forEach { out.put(it, a.get(it)) }
            is String -> if (a.has(keys)) out.put(keys, a.get(keys))
            is JSONArray -> for (i in 0 until keys.length()) { val k = keys.optString(i); if (a.has(k)) out.put(k, a.get(k)) }
            is JSONObject -> keys.keys().forEach { out.put(it, if (a.has(it)) a.get(it) else keys.get(it)) }
        }
        return out
    }

    /** 바뀐 것 {키: {oldValue, newValue}} */
    fun set(name: String, items: JSONObject): JSONObject {
        val a = area(name)
        val changes = JSONObject()
        items.keys().forEach { k ->
            val c = JSONObject()
            if (a.has(k)) c.put("oldValue", a.get(k))
            c.put("newValue", items.get(k))
            a.put(k, items.get(k))
            changes.put(k, c)
        }
        if (name != "session") save()
        return changes
    }

    fun remove(name: String, keys: Any?): JSONObject {
        val a = area(name)
        val list = when (keys) {
            is String -> listOf(keys)
            is JSONArray -> (0 until keys.length()).map { keys.optString(it) }
            else -> emptyList()
        }
        val changes = JSONObject()
        for (k in list) if (a.has(k)) { changes.put(k, JSONObject().put("oldValue", a.get(k))); a.remove(k) }
        if (name != "session" && changes.length() > 0) save()
        return changes
    }

    fun clear(name: String): JSONObject {
        val a = area(name)
        val changes = JSONObject()
        a.keys().asSequence().toList().forEach { changes.put(it, JSONObject().put("oldValue", a.get(it))); a.remove(it) }
        if (name != "session") save()
        return changes
    }

    fun localString(key: String): String = local.optString(key, "")

    /** 0.3초 모아서 한 번에 쓴다 (바꿀 때마다 쓰면 느림) */
    @Synchronized private fun save() {
        pending?.cancel(false)
        val text = local.toString()
        pending = io.schedule({ write(text) }, 300, TimeUnit.MILLISECONDS)
    }

    @Synchronized fun flush() {
        pending?.cancel(false)
        pending = null
        val text = local.toString()
        io.submit { write(text) }.get()
    }

    private fun write(text: String) {
        val tmp = File(file.parentFile, "storage.json.tmp")
        tmp.writeText(text)
        tmp.renameTo(file)
    }
}
