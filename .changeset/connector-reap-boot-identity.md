---
'clawboo': patch
---

Starting Clawboo no longer risks stopping an unrelated process. At startup, Clawboo stops connector processes that a crashed or force-quit server left running, and it told them apart from other processes partly by the system's boot time. Inside a container that is the host's boot time, which a container restart keeps, so a connector's process id from before the restart could name another process. On a system without `ps`, that process was stopped with no check of when it started.

Each connector record now also names the PID namespace it was written in and when that namespace's first process started. A record from another namespace, or from before the namespace started again, is dropped without stopping anything. A process whose start time cannot be read is left running, and the server log says why. On Linux, records written by an older version are dropped the same way. macOS and Windows have no PID namespaces and behave as before.
