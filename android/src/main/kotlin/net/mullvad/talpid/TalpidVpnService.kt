package net.mullvad.talpid

import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import kotlin.properties.Delegates.observable
import net.mullvad.talpid.tun_provider.TunConfig

open class TalpidVpnService : VpnService() {
    private var activeTunStatus by observable<CreateTunResult?>(null) { _, oldTunStatus, _ ->
        val oldTunFd = when (oldTunStatus) {
            is CreateTunResult.Success -> oldTunStatus.tunFd
            is CreateTunResult.InvalidDnsServer -> oldTunStatus.tunFd
            else -> null
        }

        if (oldTunFd != null) {
            ParcelFileDescriptor.adoptFd(oldTunFd).close()
        }
    }

    private val tunIsOpen
        get() = activeTunStatus?.isOpen ?: false

    private var currentTunConfig = defaultTunConfig()
    private var tunIsStale = false

    protected var disallowedApps: List<String>? = null

    val connectivityListener = ConnectivityListener()

    override fun onCreate() {
        connectivityListener.register(this)
    }

    override fun onDestroy() {
        connectivityListener.unregister()
    }

    fun getTun(config: TunConfig): CreateTunResult {
        synchronized(this) {
            val tunStatus = activeTunStatus

            if (config == currentTunConfig && tunIsOpen && !tunIsStale) {
                return tunStatus!!
            } else {
                val newTunStatus = createTun(config)

                currentTunConfig = config
                activeTunStatus = newTunStatus
                tunIsStale = false

                return newTunStatus
            }
        }
    }

    fun createTun() {
        synchronized(this) {
            activeTunStatus = createTun(currentTunConfig)
        }
    }

    fun createTunIfClosed(): Boolean {
        synchronized(this) {
            if (!tunIsOpen) {
                activeTunStatus = createTun(currentTunConfig)
            }

            return tunIsOpen
        }
    }

    fun recreateTunIfOpen(config: TunConfig) {
        synchronized(this) {
            if (tunIsOpen) {
                currentTunConfig = config
                activeTunStatus = createTun(config)
            }
        }
    }

    fun closeTun() {
        synchronized(this) {
            activeTunStatus = null
        }
    }

    fun markTunAsStale() {
        synchronized(this) {
            tunIsStale = true
        }
    }

    private fun createTun(config: TunConfig): CreateTunResult {
        if (VpnService.prepare(this) != null) {
            // VPN permission wasn't granted
            return CreateTunResult.PermissionDenied()
        }

        val builder = Builder().apply {
            for (address in config.addresses) {
                addAddress(address, prefixForAddress(address))
            }

            for (dnsServer in config.dnsServers) {
                addDnsServer(dnsServer)
            }

            for (route in config.routes) {
                addRoute(route.address, route.prefixLength.toInt())
            }

            disallowedApps?.let { apps ->
                for (app in apps) {
                    addDisallowedApplication(app)
                }
            }

            if (Build.VERSION.SDK_INT >= 29) {
                setMetered(false)
            }

            setMtu(config.mtu)
            setBlocking(false)
        }

        val vpnInterface = builder.establish()
        val tunFd = vpnInterface?.detachFd()

        if (tunFd != null) {
            waitForTunnelUp(tunFd, config.routes.any { route -> route.isIpv6 })

            return CreateTunResult.Success(tunFd)
        } else {
            return CreateTunResult.TunnelDeviceError()
        }
    }

    fun bypass(socket: Int): Boolean {
        return protect(socket)
    }

    private fun prefixForAddress(address: InetAddress): Int {
        when (address) {
            is Inet4Address -> return 32
            is Inet6Address -> return 128
            else -> throw RuntimeException("Invalid IP address (not IPv4 nor IPv6)")
        }
    }

    private external fun defaultTunConfig(): TunConfig
    private external fun waitForTunnelUp(tunFd: Int, isIpv6Enabled: Boolean)
}
