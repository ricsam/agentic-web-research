"""Offline chart checks (requires helm and PyYAML).

Optionally compare ALL six rendered specs with an operator-supplied, sanitized
physical snapshot: AWR_PHYSICAL_SNAPSHOT=/tmp/awr-r5d-chat-safe.json python3 ...
For the pre-release 14:21 snapshot, additionally set AWR_SNAPSHOT_FENCED=1;
this asserts and reports only the approved maintenance selector difference.
Never queries the cluster or reads Secret/ConfigMap payloads.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import yaml

CHART = Path(__file__).resolve().parents[1] / "agentic-web-research"
NAME = "agentic-web-research"
OVERLAY = CHART / "values-r5d-chat.yaml"


def render(*options):
    output = subprocess.check_output(
        ["helm", "template", "awr", str(CHART), "--namespace", "r5d-chat", *options],
        text=True,
    )
    return {(obj["kind"], obj["metadata"]["name"]): obj
            for obj in yaml.safe_load_all(output) if obj}


def normalized_spec(obj):
    """Default omitted fields, but retain every nondefault/unknown spec field.

    Service allocations are deliberately not desired source configuration.
    DATABASE_URL is masked ONLY for the known, non-secret interpolation form.
    """
    spec = copy.deepcopy(obj["spec"])
    kind = obj["kind"]
    if kind == "Service":
        for key in ("clusterIP", "clusterIPs"):
            spec.pop(key, None)
        for key, value in {"type": "ClusterIP", "sessionAffinity": "None",
                           "internalTrafficPolicy": "Cluster", "ipFamilies": ["IPv4"],
                           "ipFamilyPolicy": "SingleStack"}.items():
            spec.setdefault(key, value)
        for port in spec["ports"]:
            port.setdefault("protocol", "TCP")
        return spec
    spec.setdefault("revisionHistoryLimit", 10)
    if kind == "Deployment":
        spec.setdefault("progressDeadlineSeconds", 600)
        spec.setdefault("strategy", {"type": "RollingUpdate", "rollingUpdate": {
            "maxSurge": "25%", "maxUnavailable": "25%"}})
    if kind == "StatefulSet":
        spec.setdefault("podManagementPolicy", "OrderedReady")
        spec.setdefault("persistentVolumeClaimRetentionPolicy", {
            "whenDeleted": "Retain", "whenScaled": "Retain"})
        spec.setdefault("updateStrategy", {"type": "RollingUpdate", "rollingUpdate": {"partition": 0}})
        for claim in spec["volumeClaimTemplates"]:
            claim.setdefault("apiVersion", "v1")
            claim.setdefault("kind", "PersistentVolumeClaim")
            claim.pop("status", None)
            if claim["metadata"].get("creationTimestamp") is None:
                claim["metadata"].pop("creationTimestamp", None)
            claim["spec"].setdefault("volumeMode", "Filesystem")
    metadata = spec["template"]["metadata"]
    if metadata.get("creationTimestamp") is None:
        metadata.pop("creationTimestamp", None)
    pod = spec["template"]["spec"]
    for key, value in {"dnsPolicy": "ClusterFirst", "restartPolicy": "Always",
                       "schedulerName": "default-scheduler", "terminationGracePeriodSeconds": 30}.items():
        pod.setdefault(key, value)
    for container in pod.get("containers", []) + pod.get("initContainers", []):
        image = container["image"]
        latest = "@" not in image and (image.endswith(":latest") or ":" not in image.rsplit("/", 1)[-1])
        container.setdefault("imagePullPolicy", "Always" if latest else "IfNotPresent")
        container.setdefault("terminationMessagePath", "/dev/termination-log")
        container.setdefault("terminationMessagePolicy", "File")
        container.setdefault("resources", {})
        for env in container.get("env", []):
            if env.get("value") == "":
                env.pop("value")
            if env["name"] == "DATABASE_URL" and env.get("value") == (
                "postgres://agentic_web_research:$(POSTGRES_PASSWORD)@"
                "agentic-web-research-postgres:5432/agentic_web_research"
            ):
                env["value"] = "<redacted>"
        for port in container.get("ports", []):
            port.setdefault("protocol", "TCP")
        for key in ("startupProbe", "readinessProbe", "livenessProbe"):
            if key not in container:
                continue
            probe = container[key]
            for field, value in {"failureThreshold": 3, "successThreshold": 1,
                                 "timeoutSeconds": 1, "periodSeconds": 10,
                                 "initialDelaySeconds": 0}.items():
                probe.setdefault(field, value)
            if "httpGet" in probe:
                probe["httpGet"].setdefault("scheme", "HTTP")
    for volume in pod.get("volumes", []):
        if "configMap" in volume:
            volume["configMap"].setdefault("defaultMode", 420)
    return spec


class ChartTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.default = render()
        cls.managed = render("-f", str(OVERLAY))

    def pod(self, kind, suffix=""):
        return self.managed[(kind, NAME + suffix)]["spec"]["template"]["spec"]

    def test_exact_resource_list(self):
        self.assertEqual(set(self.managed), {
            ("Deployment", NAME), ("Deployment", NAME + "-searxng"),
            ("StatefulSet", NAME + "-postgres"), ("Service", NAME),
            ("Service", NAME + "-searxng"), ("Service", NAME + "-postgres"),
        })

    def test_digest_pins_and_pull_policies(self):
        for kind, suffix, image, policy in [
            ("Deployment", "", "ghcr.io/ricsam/agentic-web-research@sha256:8cdaa243c3db629f2d580f909e45a725d8e03c457ea4876665f9aee9a0984c35", "IfNotPresent"),
            ("Deployment", "-searxng", "docker.io/searxng/searxng@sha256:11a9b34cdc0b1ec2b991470a2762ecb5a1a531898289fb51dcd015260450729e", "Always"),
            ("StatefulSet", "-postgres", "docker.io/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685", "IfNotPresent"),
        ]:
            container = self.pod(kind, suffix)["containers"][0]
            self.assertEqual(container["image"], image)
            self.assertEqual(container.get("imagePullPolicy", "IfNotPresent"), policy)
        self.assertNotIn("command", self.pod("Deployment")["containers"][0])
        self.assertNotIn("args", self.pod("Deployment")["containers"][0])

    def test_placement_and_full_mounts(self):
        for obj in self.managed.values():
            if "template" not in obj["spec"]:
                continue
            pod = obj["spec"]["template"]["spec"]
            self.assertEqual(pod["nodeSelector"], {"kubernetes.io/hostname": "hetzner-kata-2"})
            self.assertEqual(pod["tolerations"], [{"key": "r5d.xyz/nodepool", "operator": "Equal", "value": "kata", "effect": "NoSchedule"}])
            self.assertNotIn("runtimeClassName", pod)
            for container in pod["containers"] + pod.get("initContainers", []):
                for mount in container.get("volumeMounts", []):
                    self.assertNotIn("subPath", mount)
                    self.assertNotIn("subPathExpr", mount)

    def test_retained_claim_and_guard(self):
        obj = self.managed[("StatefulSet", NAME + "-postgres")]
        claim = normalized_spec(obj)["volumeClaimTemplates"][0]
        self.assertEqual(claim["metadata"]["name"], "data")
        self.assertEqual(claim["spec"], {"accessModes": ["ReadWriteOnce"],
            "resources": {"requests": {"storage": "2Gi"}},
            "storageClassName": "rook-ceph-block", "volumeMode": "Filesystem"})
        pod = self.pod("StatefulSet", "-postgres")
        postgres, guard = pod["containers"][0], pod["initContainers"][0]
        self.assertEqual(guard["name"], "migration-existing-pgdata-guard")
        self.assertEqual(guard["image"], postgres["image"])
        self.assertEqual(guard["securityContext"], postgres["securityContext"])
        self.assertEqual(guard["securityContext"]["runAsUser"], 70)
        self.assertEqual(guard["command"], ["sh", "-ec", 'test -s "$PGDATA/global/pg_control"; test "$(cat "$PGDATA/PG_VERSION")" = "16"; test -d "$PGDATA/base"; echo ORIGINAL_PGDATA_GUARD_PASSED > /dev/termination-log; echo ORIGINAL_PGDATA_GUARD_PASSED'])
        self.assertEqual(guard["env"], [{"name": "PGDATA", "value": "/var/lib/postgresql/data/pgdata"}])
        self.assertEqual(guard["volumeMounts"], [{"name": "data", "mountPath": "/var/lib/postgresql/data", "readOnly": True}])
        self.assertEqual(postgres["volumeMounts"], [{"name": "data", "mountPath": "/var/lib/postgresql/data"}])

    def test_guard_rejects_empty_incomplete_and_wrong_major_data(self):
        guard = self.pod("StatefulSet", "-postgres")["initContainers"][0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            command = list(guard["command"])
            command[-1] = command[-1].replace("/dev/termination-log", str(root / "termination-log"))
            env = {**os.environ, "PGDATA": directory}

            def succeeds():
                return subprocess.run(command, env=env, capture_output=True).returncode == 0

            self.assertFalse(succeeds())
            (root / "global").mkdir()
            (root / "global" / "pg_control").write_text("test fixture, not database bytes")
            (root / "PG_VERSION").write_text("16\n")
            self.assertFalse(succeeds())  # base still absent
            (root / "base").mkdir()
            (root / "PG_VERSION").write_text("15\n")
            self.assertFalse(succeeds())
            (root / "PG_VERSION").write_text("16\n")
            self.assertTrue(succeeds())
            self.assertEqual((root / "termination-log").read_text().strip(), "ORIGINAL_PGDATA_GUARD_PASSED")

    def test_external_config_and_secret_refs(self):
        config = self.pod("Deployment", "-searxng")["volumes"][0]["configMap"]
        self.assertEqual(config["name"], NAME + "-searxng")
        self.assertNotIn(("ConfigMap", config["name"]), self.managed)
        keys = set()
        for obj in self.managed.values():
            for c in obj["spec"].get("template", {}).get("spec", {}).get("containers", []):
                for env in c.get("env", []):
                    if "valueFrom" in env:
                        ref = env["valueFrom"]["secretKeyRef"]
                        self.assertEqual(ref["name"], "r5d-chat-secrets")
                        self.assertEqual(ref["key"], env["name"])
                        keys.add(ref["key"])
        self.assertEqual(keys, {"ADMIN_PASSWORD", "APP_SECRET", "POSTGRES_PASSWORD", "BOOTSTRAP_API_KEY", "BOOTSTRAP_LLM_API_KEY", "BOOTSTRAP_LLM_HEADERS_JSON", "SEARXNG_SECRET"})

    def test_ordinary_selector_and_explicit_fence_override(self):
        selector = self.managed[("Service", NAME)]["spec"]["selector"]
        self.assertEqual(selector, {"app.kubernetes.io/name": NAME})
        labels = self.managed[("Deployment", NAME)]["spec"]["template"]["metadata"]["labels"]
        self.assertNotIn("migration.r5d.dev/maintenance", labels)
        fenced = render("-f", str(OVERLAY), "--set", "service.maintenanceFence=true")
        self.assertEqual(fenced[("Service", NAME)]["spec"]["selector"], {
            "app.kubernetes.io/name": NAME, "migration.r5d.dev/maintenance": "true"})

    def test_default_opt_outs(self):
        pod = self.default[("StatefulSet", NAME + "-postgres")]["spec"]["template"]["spec"]
        self.assertNotIn("initContainers", pod)
        self.assertNotIn("nodeSelector", pod)
        self.assertNotIn("tolerations", pod)
        self.assertIn(("ConfigMap", NAME + "-searxng"), self.default)
        self.assertEqual(self.default[("Deployment", NAME)]["spec"]["template"]["spec"]["containers"][0]["image"], "ghcr.io/ricsam/agentic-web-research:f7d1fd2a184ba2610b1673d808f232dfdc368adf")

    def test_normalization_retains_meaningful_spec_drift(self):
        for key, path, value in [
            (("Service", NAME), ["selector", "unexpected"], "true"),
            (("Service", NAME), ["internalTrafficPolicy"], "Local"),
            (("Deployment", NAME), ["template", "spec", "runtimeClassName"], "kata"),
            (("StatefulSet", NAME + "-postgres"), ["podManagementPolicy"], "Parallel"),
        ]:
            changed = copy.deepcopy(self.managed[key])
            target = changed["spec"]
            for part in path[:-1]:
                target = target[part]
            target[path[-1]] = value
            self.assertNotEqual(normalized_spec(changed), normalized_spec(self.managed[key]))

    @unittest.skipUnless(os.environ.get("AWR_PHYSICAL_SNAPSHOT"), "optional sanitized physical snapshot not supplied")
    def test_whole_specs_against_physical_snapshot(self):
        snapshot = json.loads(Path(os.environ["AWR_PHYSICAL_SNAPSHOT"]).read_text())
        self.assertEqual(snapshot["namespace"], "r5d-chat")
        self.assertTrue(snapshot.get("checks", {}).get("databaseUrlUsesExpectedPasswordSubstitution"),
                        "snapshot must independently verify the masked database URL interpolation")
        physical = {(obj["kind"], obj["metadata"]["name"]): obj for obj in snapshot["items"]}
        for key, obj in self.managed.items():
            with self.subTest(resource=key):
                self.assertIn(key, physical)
                desired, observed = normalized_spec(obj), normalized_spec(physical[key])
                if key == ("Service", NAME) and os.environ.get("AWR_SNAPSHOT_FENCED") == "1":
                    self.assertEqual(observed["selector"].pop("migration.r5d.dev/maintenance"), "true")
                    self.assertNotIn("migration.r5d.dev/maintenance", desired["selector"])
                    print("Approved residual: Service/agentic-web-research maintenance selector true -> absent")
                # Do not dump a potentially sensitive differing spec into a test log.
                self.assertTrue(desired == observed, f"spec mismatch: {key}")


if __name__ == "__main__":
    unittest.main()
