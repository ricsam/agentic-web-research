# PROJECT research chart convergence: r5d-chat

Source-only, 2026-09-10. This is the PROJECT research service in the physical
`r5d-chat` namespace, **not** platform AWR or the `agentic-web-research` namespace.
No live writes, Helm adoption, provider calls, CI, gateway calls, image build,
chart packaging, push, or deployment were performed by this source task.

## Rendering and tests

From the repository root (Helm 3.17.4, Python 3 with PyYAML 6.0.1):

```sh
helm lint deploy/helm/agentic-web-research
helm lint deploy/helm/agentic-web-research \
  -f deploy/helm/agentic-web-research/values-r5d-chat.yaml
helm template awr deploy/helm/agentic-web-research -n r5d-chat \
  -f deploy/helm/agentic-web-research/values-r5d-chat.yaml
python3 deploy/helm/tests/test_chart.py -v
```

Default chart rendering was compared before/after and is semantically unchanged.
The overlay renders exactly these six resources (all in `r5d-chat` when installed;
templates omit namespace and use the Helm release namespace):

| Kind | Name | Observed physical UID |
| --- | --- | --- |
| Deployment | agentic-web-research | a3800a52-5a96-4459-9a85-5604b949de33 |
| Deployment | agentic-web-research-searxng | c8af65a8-17dc-4b2a-8202-c98559193c62 |
| StatefulSet | agentic-web-research-postgres | d2417af0-b821-4c2b-b4ca-f240c0077286 |
| Service | agentic-web-research | a6a39002-2b89-41d7-9d53-cd1394dba53a |
| Service | agentic-web-research-postgres | 63fdac17-5e75-4f30-a974-63587eacc45b |
| Service | agentic-web-research-searxng | 7be92492-2e38-4817-a9c1-59105ba2b382 |

No Secret, ConfigMap, standalone PVC, ingress, NetworkPolicy, hook, or migration
Job is rendered by the overlay. No chart version or packaged archive is changed;
any later deployment must use this reviewed source, not the old packaged chart.

## Physical comparison and boundaries

Evidence: parent-supplied sanitized `/tmp/chat-helm-current-safe.json` at
14:12 UTC, then read-only SSH to `hetzner` using its physical `kubectl` at
14:21:17 UTC. The latter has the same resource UIDs/specs and fills in the
previously masked numeric `BOOTSTRAP_LLM_MAX_OUTPUT_TOKENS=4096`. Its sanitized
comparison file is `/tmp/awr-r5d-chat-safe.json` (local evidence, not committed).
The database URL was checked for equality to the chart's existing
`$(POSTGRES_PASSWORD)` interpolation form without exposing credentials.

```sh
AWR_PHYSICAL_SNAPSHOT=/tmp/awr-r5d-chat-safe.json AWR_SNAPSHOT_FENCED=1 \
  python3 deploy/helm/tests/test_chart.py -v
```

The test compares **whole specs** of all six resources, not a selected-field
subset. It fills known Kubernetes defaults (controller strategies/history,
retention, pod/probe/port/image pull defaults, ConfigMap mode, claim GVK and
Filesystem mode, empty env strings), ignores claim status/null creation times,
and excludes Service-assigned `clusterIP`/`clusterIPs`. It retains nondefault
and unknown fields, with tests verifying that meaningful drift is detected.
It masks only the exact known database URL interpolation. The original
14:12 snapshot cannot prove its redacted token count or database URL equality
on its own; the separate 14:21 read-only check supplies that evidence.

Meaningful residuals/limitations:

- **One intentional spec delta:** the 14:21 app Service selector includes
  `migration.r5d.dev/maintenance: "true"`; ordinary desired values set
  `service.maintenanceFence: false` and omit that selector. Parent explicitly
  approved ordinary source configuration and separately owns live fence release
  after readiness/consumer checks. No live release is claimed here. To compare
  a later unfenced snapshot, omit `AWR_SNAPSHOT_FENCED=1`; unexpected fence state
  fails the test. A fenced render is still possible with
  `--set service.maintenanceFence=true` for explicit operator review.
- **No other normalized spec delta** against the 14:21 snapshot.
- Installed metadata has `app.kubernetes.io/managed-by: Helm`, but the supplied
  snapshot has no Helm release Secrets or `meta.helm.sh` ownership annotations.
  Those are not proof of an installed release. Templates do not reproduce
  server UIDs, resource versions or timestamps, and do not perform adoption.
  Ownership/first-adoption review is a separate parent-owned operation. Never
  use replacement/`--force`, first-adoption `--atomic`, or cleanup-on-failure to
  make these retained resources fit a release.
- `searxng.existingConfigMap: agentic-web-research-searxng` references the
  installed ConfigMap without rendering it. Only its `settings.yml` key was
  observed; **payload equality is not claimed**. Keep that ConfigMap external.
- Secret values were not read. All existing `r5d-chat-secrets` references and
  keys remain unchanged: `ADMIN_PASSWORD`, `APP_SECRET`, `POSTGRES_PASSWORD`,
  optional `BOOTSTRAP_API_KEY`, `BOOTSTRAP_LLM_API_KEY`,
  `BOOTSTRAP_LLM_HEADERS_JSON`, and SearXNG's `SEARXNG_SECRET`.
- Service allocations remain external: app `10.43.68.157`, Postgres
  `10.43.32.85`, SearXNG `10.43.198.130` at observation. Do not recreate Services
  or hardcode allocator state into reusable values.

## Retained database and workload invariants

The immutable claim-template name is **`data`**, not `postgres-data`. Preserve:

- StatefulSet `agentic-web-research-postgres`, template `data`, 2Gi,
  `rook-ceph-block`, `ReadWriteOnce`, `Filesystem` (API default).
- Existing PVC `data-agentic-web-research-postgres-0`, UID
  `ced63750-0ecf-4d7d-8144-510b5dd627f6`, bound PV
  `pvc-ba0414e3-2d78-42f3-9c1a-b0e64bde0819`. Never recreate or rename it.
- Accepted PostgreSQL 16 digest, UID/GID 70, fsGroup 70,
  `PGDATA=/var/lib/postgresql/data/pgdata`, full `/var/lib/postgresql/data`
  mount; no `subPath`/`subPathExpr`.
- Existing `migration-existing-pgdata-guard` init container: identical command,
  image, read-only full mount, security context and resources. It checks a
  nonempty `global/pg_control`, major `16`, and `base` before startup. This is
  the existing fail-closed guard, **not** a new migration or integrity framework.
  It is opt-in and must not be enabled on a fresh database volume.
- Accepted app and SearXNG digests, pull policies, env refs, resources, probes,
  volumes and security contexts. App `command` and `args` remain **absent**,
  preserving the accepted image entrypoint; no `bun dist/server.js --no-migrate`
  override is introduced.
- All three controllers target `hetzner-kata-2` with the installed nodepool
  toleration and **no runtimeClassName** (ordinary pods).

Before any separately authorized live Helm operation, refresh the physical
inventory, ownership state, PVC binding, external config reference and fence
state. These source checks do not authorize or establish safe live adoption.

## Parent source publication

The infrastructure parent subsequently released only the PROJECT research Service
maintenance selector (operation e7a49230, 10 September), with readiness from chat
and the same ready EndpointSlice. No controller, image, DB or provider task changed.
This source checkpoint is published with CI skipped deliberately: chart-only
convergence must not rebuild/overwrite the unrelated mutable `latest` image.
The existing accepted app digest remains authoritative. Helm adoption is still a
separate optional operator action; no adoption is needed for image-only updates.
