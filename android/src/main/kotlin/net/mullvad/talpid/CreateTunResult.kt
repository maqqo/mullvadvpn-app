package net.mullvad.talpid

import java.net.InetAddress

sealed class CreateTunResult {
    open val isOpen
        get() = false

    class Success(val tunFd: Int) : CreateTunResult() {
        override val isOpen
            get() = true
    }

    class InvalidDnsServer(val address: InetAddress, val tunFd: Int) : CreateTunResult() {
        override val isOpen
            get() = true
    }

    class PermissionDenied : CreateTunResult()
    class TunnelDeviceError : CreateTunResult()
}
