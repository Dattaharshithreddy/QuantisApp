# QUANTIS Release Process

## Version numbering

`MAJOR.MINOR.PATCH`  
- MAJOR: Breaking architectural change or new trading engine
- MINOR: New screen, new feature, new test suite
- PATCH: Bug fix, performance improvement, wording change

Current: **v6.9.9**

---

## Pre-release checklist

### 1. Code freeze
- [ ] All planned work for this release is merged to `main`
- [ ] No open PRs targeting this release
- [ ] `buildInfo.ts` updated with new version, date, and note

### 2. Automated tests
```bash
cd QuantisApp
npm test         # runs all 9 suites, must show 9/9 passed
npx tsc --noEmit --skipLibCheck   # must produce zero errors
```
Both must pass before proceeding.

### 3. E2E manual test
- Run `docs/E2E_TEST_SCRIPT.md` on a physical device
- All 10 passes must be marked ✓
- Zero crashes in Health Dashboard at end of test run

### 4. Security audit
- Open app → Health Dashboard → verify security audit passed
- All 5 checks green
- If any fail: stop release, fix, re-run E2E

### 5. Build
```bash
npx eas-cli build --platform android --profile production
```
This triggers CI/CD pipeline automatically on push to `main`.

### 6. Release notes
- Document all changes since last release
- Categorise: New features / Bug fixes / Breaking changes / Known issues
- Store in `docs/RELEASE_NOTES_vX_Y_Z.md`

---

## Versioning steps (exact commands)

```bash
# 1. Update buildInfo.ts
# BUILD_VERSION = 'X.Y.Z'
# BUILD_DATE    = 'YYYY-MM-DD IST'
# BUILD_NOTE    = 'vX.Y.Z — <summary>'

# 2. Commit and push
git add src/buildInfo.ts
git commit -m "chore: bump version to vX.Y.Z"
git push origin main

# 3. CI runs automatically:
#    validate → test → build (EAS)

# 4. Tag the release
git tag vX.Y.Z
git push origin vX.Y.Z
```

---

## Rollback procedure

If a release causes critical issues:

1. Identify the last known-good commit: `git log --oneline`
2. Revert: `git revert HEAD` (or specific commit hash)
3. Push to main — CI rebuilds automatically
4. Distribute the reverted build

For live trading issues specifically:
1. Instruct users to activate Kill Switch immediately
2. Disable live trading in the reverted build if needed (`LiveTradeSettings`)
3. Investigate via Health Dashboard crash logs and Audit Trail

---

## EAS build profiles

Defined in `eas.json`:

| Profile | Purpose | Auto-triggers |
|---------|---------|---------------|
| `preview` | Testing APK (internal use) | Every push to `main` |
| `production` | Release APK (signed, optimised) | Manual only |

---

## Secrets required

| Secret | Where | Used for |
|--------|-------|---------|
| `EXPO_TOKEN` | GitHub → Settings → Secrets | EAS CLI authentication |

Store at: `Settings → Secrets and variables → Actions`
