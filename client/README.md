# Client builds

Each subfolder is one self-contained client version:

```text
client/versions/1.8/index.html, classes.js, assets.epk, lang/...
```

The admin page (Admin → Versions) is the intended way to add builds: upload
a zip whose root contains those files. Folders copied here manually are
registered on the next backend restart.

Do not commit client files to this repository — get builds only from sources
you trust and verify the in-game signature badge.
