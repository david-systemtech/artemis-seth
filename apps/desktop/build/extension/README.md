# The bundled browser extension

`electron-builder.yml` copies this directory into the packaged app as
`resources/extension`, and `main/index.ts` looks there for
`artemis-extension-<version>.zip` — the archive Settings → Browser hands over
for "Get the extension".

The zip is written here by `scripts/package-extension.ts`, which the release
workflow runs once before packaging. It is not committed: a build that has not
run that script finds no zip, `bundledVersion` is `null`, and the pane says
this copy of Artemis does not ship the extension rather than offering a button
that saves nothing.

This file exists so the directory does, because `extraResources` copies a
directory that has to be there.
