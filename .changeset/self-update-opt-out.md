---
'clawboo': patch
---

The dashboard's update can be turned off, and it is no longer offered where it cannot work.

`CLAWBOO_DISABLE_SELF_UPDATE=1`, or `disableSelfUpdate` in the operator settings file, removes the **Update available** chip, makes `GET /api/system/self-version` answer as it does with `?local=1` (no call to npm's registry), and makes `POST /api/system/self-update` refuse with a message saying an administrator turned it off. Use it on an install that something else manages, such as a container image, a distro package or a service manager. A browser that last saw an update available checks again before showing the chip, so it does not linger after the switch, or after an update.

Without it, a global install whose folders the server's user cannot write, such as a root-owned `/usr/local`, is no longer offered **Click to update**. The update there could only fail with a permission error or leave a copy that no longer matches what installed it. The chip copies the update command instead, and the update route refuses with the reason.
