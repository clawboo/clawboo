---
'clawboo': patch
---

`clawboo stop` and `clawboo restart` no longer stop a server that stops answering while its agent runs are going. When three polls in a row get no answer during the wait, the command now checks the server's port. If the server is gone, the stop finishes as before. If it is still there but silent, the command leaves it running, says "The server stopped answering while N agent runs were going, so it was not stopped.", prints a command that stops its process by hand, and exits 1. Before, it went ahead and stopped it, which could interrupt those runs or report a busy server as not running. A server that does not answer the request to hold it gets the same hand-stop command; `--force` cannot reach a silent server, because it finds a server by asking it.

A server too busy to answer is now never mistaken for no server. When the port Clawboo recorded still takes connections but answers nothing, `clawboo stop` (with or without `--force`) keeps its record, says the server was not stopped and prints the hand-stop command, instead of deleting the record of a running server and reporting that none was running. `clawboo restart` starts no second server while that port is held, by a silent server or by a Clawboo server answering there, and exits 1 instead.

When the command cannot release the hold it placed, it now says so on every path, including a server that did not answer the hold and a stop that found no server: the server then starts new work again within a minute, when the hold lapses.
