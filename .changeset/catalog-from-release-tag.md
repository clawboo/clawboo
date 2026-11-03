---
'clawboo': patch
---

A release reads the Marketplace catalog published with it. Every install used to read the catalog index from the `main` branch, so it got whatever `main` held that day, content written for a newer version included, and one change there reached every install at once. A release now reads the index at its own tag (`clawboo@<version>`). A development build still reads `main`, a release whose tag has no index falls back to `main`, and `CLAWBOO_CATALOG_INDEX_URL` still overrides both.
