# Release Guide

1. Update `module.json` and `CHANGELOG.md`.
2. Run the full GM Panel QA suite from the development workspace.
3. Confirm the manifest `download` URL uses the matching version and `simone-gm-panel.zip`.
4. Commit and push the approved source.
5. Create and push tag `v1.0.0`.
6. GitHub Actions publishes `module.json` and `simone-gm-panel.zip`.
7. Test installation from `https://github.com/simone-bianco/vtt-simone-gm-panel-core/releases/latest/download/module.json` in a clean Foundry VTT data path.
8. Submit or update the package in the Foundry package administration portal only after public install and update checks pass.
