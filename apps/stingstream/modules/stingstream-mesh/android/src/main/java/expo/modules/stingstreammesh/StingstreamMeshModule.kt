package expo.modules.stingstreammesh

import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import uniffi.stingstream_mesh_ffi.GroupInfo
import uniffi.stingstream_mesh_ffi.JoinResult
import uniffi.stingstream_mesh_ffi.MeshEventListener
import uniffi.stingstream_mesh_ffi.MeshException
import uniffi.stingstream_mesh_ffi.MeshHandle
import uniffi.stingstream_mesh_ffi.MeshStatus
import uniffi.stingstream_mesh_ffi.PeerEvent
import uniffi.stingstream_mesh_ffi.PeerInfo
import uniffi.stingstream_mesh_ffi.StreamStats
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The app's embedded mesh light node.
 *
 * A thin wrapper: everything of substance is in `stingstream-mesh-ffi`, and this file exists to
 * own the Android-shaped parts of it — where the data directory lives, what happens when the app
 * goes to the background, and turning Rust records into the plain maps the JS side reads.
 *
 * ## Lifecycle
 *
 * The endpoint costs a QUIC socket, a SQLite handle and two worker threads, and it is what keeps
 * a group's other members seeing this device as online. So:
 *
 *  * `OnCreate` does **not** start it. The app starts it explicitly after login, when it knows
 *    which groups to join.
 *  * `OnActivityEntersBackground` starts an idle timer rather than stopping immediately, because
 *    backgrounding is what happens when the user answers a message mid-film. Playback holds the
 *    node open through [keepAwake].
 *  * `OnActivityEntersForeground` cancels the timer, and restarts the node if the timer had
 *    already fired.
 *
 * On a TV the idle timeout defaults to "never": a TV is mains-powered and is exactly the device
 * the rest of the group most wants to find online.
 */
class StingstreamMeshModule : Module() {

  private var handle: MeshHandle? = null
  private var lastDataDir: String? = null
  private var lastConfigJson: String = ""
  private var idleTimeoutMs: Long = defaultIdleTimeoutMs()

  /** Set while a player is using the node, which suspends the idle timeout entirely. */
  private val keepAwake = AtomicBoolean(false)

  private var scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private var idleJob: Job? = null

  /**
   * Whether `libstingstream_mesh_ffi.so` is actually in the APK.
   *
   * The generated uniffi bindings are committed, so this module *compiles* whether or not the
   * Rust cross-compile has been run — which is what lets someone working on a screen build the
   * app without a Rust toolchain (see the module's build.gradle). Touching any uniffi class
   * without the library present throws `UnsatisfiedLinkError` from a static initialiser, so every
   * entry point checks this first and the module answers `available: false` instead. The app then
   * behaves exactly as it does on web: streams are proxied by the home node.
   *
   * `System.loadLibrary` rather than a file check: it is the same loader JNA ends up using, so a
   * library that is present but wrong for this ABI reads as missing here too, which is the honest
   * answer.
   */
  private val libraryPresent: Boolean by lazy {
    try {
      System.loadLibrary("stingstream_mesh_ffi")
      true
    } catch (e: Throwable) {
      android.util.Log.w(
        TAG,
        "libstingstream_mesh_ffi.so is not in this build; the mesh is unavailable and streams " +
          "will be proxied by the home node. Build it with " +
          "apps/stingstream/scripts/build-mesh-android.ps1.",
        e,
      )
      false
    }
  }

  /**
   * True on a television. Android TV and Google TV report the leanback feature; an emulator
   * running a TV image does too, which is what the acceptance run depends on.
   */
  private val isTelevision: Boolean
    get() = appContext.reactContext
      ?.packageManager
      ?.hasSystemFeature("android.software.leanback") == true

  override fun definition() = ModuleDefinition {
    Name("StingstreamMesh")

    Events(EVENT_PEER_ONLINE, EVENT_PEER_OFFLINE, EVENT_STREAM_STATS, EVENT_STATE)

    /**
     * Start the node, or return the running one's status if it is already up.
     *
     * `configJson` is passed to Rust verbatim; see `MeshConfigInput` in
     * `mesh/crates/stingstream-mesh-ffi/src/config.rs` for the fields.
     */
    AsyncFunction("start") { configJson: String? ->
      synchronized(this@StingstreamMeshModule) {
        handle?.let { return@AsyncFunction statusMap(it.status()) }

        if (!libraryPresent) {
          throw MeshUnavailableException(
            "this build has no mesh native library; run apps/stingstream/scripts/build-mesh-android.ps1",
          )
        }

        val context = appContext.reactContext
          ?: throw MeshUnavailableException("no Android context; the app is being torn down")

        // `filesDir`, never external storage or the cache: node.key is this device's identity in
        // every group it has joined, and the cache is a directory the OS may empty at any time.
        val dir = File(context.filesDir, MESH_DIR_NAME).apply { mkdirs() }
        val json = withDefaults(configJson)

        val started = try {
          MeshHandle.start(dir.absolutePath, json)
        } catch (e: MeshException) {
          throw MeshFailedException(e.message ?: "the mesh would not start", e)
        }
        started.setListener(Listener())

        handle = started
        lastDataDir = dir.absolutePath
        lastConfigJson = json
        cancelIdleTimer()
        emitState("running")
        statusMap(started.status())
      }
    }

    /** Stop the node. Idempotent; safe to call when it was never started. */
    AsyncFunction("stop") {
      synchronized(this@StingstreamMeshModule) {
        cancelIdleTimer()
        stopLocked()
      }
    }

    /** True when the node is up. The JS layer treats "not running" as "do not rewrite URLs". */
    Function("isRunning") { handle != null }

    /**
     * True when the mesh can actually run here.
     *
     * Reaching this code means the *module* linked, but the Rust library is a separate artifact
     * that a debug build is allowed to be missing — so this reports whether the library loaded,
     * not whether the module exists. The JS wrapper treats false exactly as it treats web.
     */
    Function("isAvailable") { libraryPresent }

    Function("getLocalPort") { handle?.localPort()?.toInt() ?: 0 }

    Function("getNodeId") { handle?.nodeId() }

    AsyncFunction("getStatus") { requireHandle().let { statusMap(it.status()) } }

    AsyncFunction("joinGroup") { invite: String ->
      requireHandle().let { joinMap(it.joinGroup(invite)) }
    }

    AsyncFunction("leaveGroup") { group: String -> requireHandle().leaveGroup(group) }

    AsyncFunction("listGroups") { requireHandle().listGroups().map(::groupMap) }

    AsyncFunction("listPeers") { group: String? ->
      requireHandle().listPeers(group?.takeIf { it.isNotBlank() }).map(::peerMap)
    }

    /**
     * Hold the node open across a backgrounding, for as long as playback lasts.
     *
     * The player calls this with `true` when it starts and `false` when it stops. Getting it wrong
     * in the "true" direction costs battery; getting it wrong in the "false" direction stops a
     * film the moment the screen turns off, so the player also releases it in its own teardown.
     */
    Function("setKeepAwake") { keep: Boolean ->
      keepAwake.set(keep)
      if (keep) cancelIdleTimer() else scheduleIdleTimerIfBackgrounded()
    }

    /**
     * How long the node may stay up in the background with nothing playing. `0` means "stop as
     * soon as the app is backgrounded"; a negative value means "never stop", which is the default
     * on a television.
     */
    Function("setIdleTimeoutMs") { ms: Double -> idleTimeoutMs = ms.toLong() }

    OnCreate {
      scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    }

    OnActivityEntersBackground {
      backgrounded = true
      scheduleIdleTimerIfBackgrounded()
    }

    OnActivityEntersForeground {
      backgrounded = false
      cancelIdleTimer()
      // Restart if the idle timer stopped us while we were away. The app's own provider also
      // re-joins its groups, but those are already in mesh.db, so this is enough on its own.
      val dir = lastDataDir
      if (handle == null && dir != null && libraryPresent) {
        scope.launch {
          synchronized(this@StingstreamMeshModule) {
            if (handle != null) return@synchronized
            try {
              val started = MeshHandle.start(dir, lastConfigJson)
              started.setListener(Listener())
              handle = started
              emitState("running")
            } catch (e: MeshException) {
              emitState("error", e.message)
            }
          }
        }
      }
    }

    OnDestroy {
      cancelIdleTimer()
      synchronized(this@StingstreamMeshModule) { stopLocked() }
      scope.cancel()
    }
  }

  // --- lifecycle helpers --------------------------------------------------------------------

  @Volatile
  private var backgrounded = false

  private fun defaultIdleTimeoutMs(): Long = if (isTelevision) -1L else DEFAULT_PHONE_IDLE_MS

  private fun scheduleIdleTimerIfBackgrounded() {
    if (!backgrounded || keepAwake.get() || handle == null) return
    val timeout = idleTimeoutMs
    if (timeout < 0) return // "never" — the TV default
    cancelIdleTimer()
    idleJob = scope.launch {
      delay(timeout)
      // Re-check under the lock: the app may have come back, or playback may have started,
      // during the delay.
      synchronized(this@StingstreamMeshModule) {
        if (!backgrounded || keepAwake.get()) return@synchronized
        stopLocked()
      }
    }
  }

  private fun cancelIdleTimer() {
    idleJob?.cancel()
    idleJob = null
  }

  /** Caller must hold the module's monitor. */
  private fun stopLocked() {
    val current = handle ?: return
    handle = null
    try {
      current.setListener(null)
      current.stop()
      current.close()
    } catch (e: Throwable) {
      android.util.Log.w(TAG, "stopping the mesh", e)
    }
    emitState("stopped")
  }

  private fun requireHandle(): MeshHandle =
    handle ?: throw MeshUnavailableException("the mesh is not running")

  // --- configuration ------------------------------------------------------------------------

  /**
   * Fill in what only Android can know, without overwriting anything the caller set.
   *
   * The node name is what other members see in the Group screen, so a device that has not been
   * named should show up as its model rather than as `localhost`.
   */
  private fun withDefaults(configJson: String?): String {
    val json = try {
      if (configJson.isNullOrBlank()) JSONObject() else JSONObject(configJson)
    } catch (e: Throwable) {
      throw MeshFailedException("the mesh configuration is not valid JSON", e)
    }
    if (!json.has("nodeName") && !json.has("node_name")) {
      json.put("nodeName", defaultNodeName())
    }
    if (!json.has("light")) json.put("light", true)
    return json.toString()
  }

  private fun defaultNodeName(): String {
    val model = Build.MODEL?.trim().orEmpty()
    val manufacturer = Build.MANUFACTURER?.trim().orEmpty()
    val name = when {
      model.isEmpty() -> manufacturer
      manufacturer.isEmpty() || model.startsWith(manufacturer, ignoreCase = true) -> model
      else -> "$manufacturer $model"
    }
    val suffix = if (isTelevision) " (TV)" else ""
    return (name.ifBlank { "StingStream app" } + suffix).take(64)
  }

  // --- events -----------------------------------------------------------------------------------

  private inner class Listener : MeshEventListener {
    override fun onPeerOnline(event: PeerEvent) = sendEvent(EVENT_PEER_ONLINE, peerEventMap(event))
    override fun onPeerOffline(event: PeerEvent) = sendEvent(EVENT_PEER_OFFLINE, peerEventMap(event))
    override fun onStreamStats(stats: StreamStats) = sendEvent(EVENT_STREAM_STATS, statsMap(stats))
  }

  private fun emitState(state: String, message: String? = null) {
    sendEvent(
      EVENT_STATE,
      mapOf(
        "state" to state,
        "message" to message,
        "localPort" to (handle?.localPort()?.toInt() ?: 0),
        "nodeId" to handle?.nodeId(),
      ),
    )
  }

  // --- record -> map ------------------------------------------------------------------------

  private fun statusMap(s: MeshStatus): Map<String, Any?> = mapOf(
    "available" to true,
    "nodeId" to s.nodeId,
    "nodeName" to s.nodeName,
    "version" to s.version,
    "localPort" to s.localPort.toInt(),
    "light" to s.light,
    "groups" to s.groups.toInt(),
    "homeRelay" to s.homeRelay,
    "relayUrls" to s.relayUrls,
    "directAddrs" to s.directAddrs,
    "directPeers" to s.directPeers.toInt(),
    "relayedPeers" to s.relayedPeers.toInt(),
    "unknownPeers" to s.unknownPeers.toInt(),
  )

  private fun groupMap(g: GroupInfo): Map<String, Any?> = mapOf(
    "id" to g.id,
    "name" to g.name,
    "coordinator" to g.coordinator,
    "createdAt" to g.createdAt,
    "members" to g.members.toInt(),
    "online" to g.online.toInt(),
  )

  private fun peerMap(p: PeerInfo): Map<String, Any?> = mapOf(
    "group" to p.group,
    "node" to p.node,
    "nodeName" to p.nodeName,
    "online" to p.online,
    "isSelf" to p.isSelf,
    "path" to p.path,
    "rttMs" to p.rttMs?.toDouble(),
    "lastSeen" to p.lastSeen,
  )

  private fun joinMap(j: JoinResult): Map<String, Any?> = mapOf(
    "group" to j.group,
    "name" to j.name,
    "coordinator" to j.coordinator,
    "via" to j.via,
    "contacted" to j.contacted,
  )

  private fun peerEventMap(e: PeerEvent): Map<String, Any?> = mapOf(
    "group" to e.group,
    "node" to e.node,
    "nodeName" to e.nodeName,
    "path" to e.path,
    "rttMs" to e.rttMs?.toDouble(),
  )

  private fun statsMap(s: StreamStats): Map<String, Any?> = mapOf(
    "group" to s.group,
    "itemKey" to s.itemKey,
    "node" to s.node,
    "status" to s.status.toInt(),
    "bytes" to s.bytes?.toDouble(),
    "ttfbMs" to s.ttfbMs.toDouble(),
    "path" to s.path,
    "rttMs" to s.rttMs?.toDouble(),
  )

  private companion object {
    const val TAG = "StingstreamMesh"
    const val MESH_DIR_NAME = "stingstream-mesh"

    const val EVENT_PEER_ONLINE = "onPeerOnline"
    const val EVENT_PEER_OFFLINE = "onPeerOffline"
    const val EVENT_STREAM_STATS = "onStreamStats"
    const val EVENT_STATE = "onMeshState"

    /**
     * Five minutes. Long enough to survive answering a message, short enough that a phone left in
     * a pocket is not holding a QUIC socket open all afternoon.
     */
    const val DEFAULT_PHONE_IDLE_MS = 5 * 60 * 1000L
  }
}

/** The node is not running, or Android has taken the context away. */
class MeshUnavailableException(message: String) :
  CodedException("ERR_MESH_UNAVAILABLE", message, null)

/** The mesh itself refused; `message` carries the Rust side's context chain. */
class MeshFailedException(message: String, cause: Throwable?) :
  CodedException("ERR_MESH_FAILED", message, cause)
