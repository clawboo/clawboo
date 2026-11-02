---
'clawboo': patch
---

The Hermes install now picks the newest Python from 3.11 to 3.13, the versions `hermes-agent` installs on. A Python 3.14 on the same machine no longer wins over an installed 3.12. When Clawboo finds no Python in that range and pipx is not installed, the error names the range it needs and the versions it found.

A Hermes agent on your ChatGPT plan stays on it. Its page shows its model with **ChatGPT plan** instead of offering OpenRouter models that would move it off the plan, and a model change through the API keeps the agent's provider unless the request names another.
