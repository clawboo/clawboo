---
'clawboo': patch
---

Starting Clawboo no longer risks stopping an unrelated process. At startup, Clawboo stops connector processes that a crashed or force-quit server left running, and it told them apart from other processes partly by the system's boot time. Inside a container that is the host's boot time, which a container restart keeps, so a connector's process id from before the restart could name another process. On a system without `ps`, that process was stopped with no check of when it started.

Each connector record now also names the PID namespace it was written in and when that namespace's first process started. A record from another namespace, or from before the namespace started again, is dropped without stopping anything. On Linux, nothing is stopped when Clawboo cannot read those two values from its own namespace. On every system, a process whose start time cannot be read is now left running: the server log says why, and the record is kept so the next start can check it again. Records written by an older version are dropped unchecked on Linux, and judged as before on macOS and Windows, which have no PID namespaces. Agent processes recorded before a container restart are never stopped either.
