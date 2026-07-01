import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  BookOpen,
  CheckCircle2,
  Copy,
  FlaskConical,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  Save,
  Send,
  Server,
  Settings,
  Trash2,
  TriangleAlert
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, fmtDate, streamSse, type SseMessage } from "@/lib/api";

type Me = { email: string };
type LlmProvider = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  headers: Record<string, string>;
  maxOutputTokens: number;
  createdAt?: string;
  updatedAt?: string;
};

type PublicLlmProvider = LlmProvider & {
  hasApiKey: boolean;
};

type LlmSettings = {
  activeProviderId?: string;
  providers: PublicLlmProvider[];
};

type HeaderEntry = {
  id: string;
  name: string;
  value: string;
};

type LlmProviderDraft = {
  name: string;
  endpoint: string;
  model: string;
  headers: HeaderEntry[];
  maxOutputTokens: number;
};
type ResearchSettings = {
  maxConcurrency: number;
  maxDepth: number;
  maxPages: number;
  timeoutMs: number;
  pageTimeoutMs: number;
  allowPrivateNetworks: boolean;
};
type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
};
type Health = {
  status: "ok" | "degraded" | "down";
  checks: Array<{ name: string; status: "ok" | "degraded" | "down"; message?: string; latencyMs?: number }>;
};
type Stats = {
  totals?: {
    total_tasks: number;
    completed_tasks: number;
    failed_tasks: number;
    tasks_24h: number;
  };
  byKey: Array<{ id: string; name: string; prefix: string; tasks: number; last_task_at?: string | null }>;
};
type Task = {
  id: string;
  query: string;
  status: string;
  error?: string | null;
  created_at: string;
  completed_at?: string | null;
};
type LogRow = {
  id: number;
  level: "info" | "warn" | "error";
  message: string;
  context: Record<string, unknown>;
  created_at: string;
};

type ResearchStreamEvent = {
  type: string;
  taskId?: string;
  at?: string;
  payload: Record<string, unknown>;
};

const defaultProviderDraft: LlmProviderDraft = {
  name: "Default",
  endpoint: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  headers: [],
  maxOutputTokens: 4096
};

const emptyLlmSettings: LlmSettings = {
  providers: []
};

const emptyResearch: ResearchSettings = {
  maxConcurrency: 2,
  maxDepth: 3,
  maxPages: 8,
  timeoutMs: 120000,
  pageTimeoutMs: 20000,
  allowPrivateNetworks: false
};

function statusVariant(status: string) {
  if (status === "ok" || status === "completed") return "secondary" as const;
  if (status === "down" || status === "failed" || status === "error") return "destructive" as const;
  return "outline" as const;
}

function stringifyPayload(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function isResearchStreamEvent(data: unknown): data is ResearchStreamEvent {
  return Boolean(data && typeof data === "object" && "type" in data && "payload" in data);
}

function asStreamEvent(message: SseMessage): ResearchStreamEvent {
  if (isResearchStreamEvent(message.data)) return message.data;
  return {
    type: message.event,
    payload: { data: message.data }
  };
}

function coerceSources(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((source) => {
    if (!source || typeof source !== "object") return [];
    const record = source as Record<string, unknown>;
    if (typeof record.url !== "string") return [];
    return [
      {
        url: record.url,
        title: typeof record.title === "string" ? record.title : undefined,
        used: typeof record.used === "boolean" ? record.used : undefined
      }
    ];
  });
}

function createHeaderEntry(name = "", value = ""): HeaderEntry {
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    name,
    value
  };
}

function headersToEntries(headers: Record<string, string> = {}) {
  return Object.entries(headers).map(([name, value]) => createHeaderEntry(name, value));
}

function headerEntriesToObject(entries: HeaderEntry[]) {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();

  for (const entry of entries) {
    const name = entry.name.trim();
    if (!name && !entry.value.trim()) continue;
    if (!name) throw new Error("Header names cannot be empty");

    const normalized = name.toLowerCase();
    if (seen.has(normalized)) throw new Error(`Duplicate header name: ${name}`);
    seen.add(normalized);
    headers[name] = entry.value;
  }

  return headers;
}

function providerToDraft(provider?: PublicLlmProvider): LlmProviderDraft {
  if (!provider) return { ...defaultProviderDraft, headers: [] };
  return {
    name: provider.name,
    endpoint: provider.endpoint,
    model: provider.model,
    headers: headersToEntries(provider.headers),
    maxOutputTokens: provider.maxOutputTokens
  };
}

function draftToPayload(draft: LlmProviderDraft) {
  return {
    name: draft.name,
    endpoint: draft.endpoint,
    model: draft.model,
    headers: headerEntriesToObject(draft.headers),
    maxOutputTokens: Number(draft.maxOutputTokens)
  };
}

function isSecretHeaderName(name: string) {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "proxy-authorization" ||
    normalized === "x-api-key" ||
    normalized.includes("api-key") ||
    normalized.includes("apikey") ||
    normalized.includes("auth") ||
    normalized.includes("token") ||
    normalized.includes("secret")
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<Me>("/admin/api/me")
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <main className="grid min-h-screen place-items-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (!me) return <Login onLogin={setMe} />;
  return <Dashboard me={me} onLogout={() => setMe(null)} />;
}

function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      onLogin(await api<Me>("/admin/api/login", { method: "POST", body: JSON.stringify({ email, password }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>agentic-web-research</CardTitle>
          <CardDescription>Admin access</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button className="w-full" type="submit" disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

function Dashboard({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [llm, setLlm] = useState<LlmSettings>(emptyLlmSettings);
  const [research, setResearch] = useState<ResearchSettings>(emptyResearch);
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [stats, setStats] = useState<Stats>({ byKey: [] });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [error, setError] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);

  async function refresh() {
    setError("");
    try {
      const [llmResult, researchResult, keysResult, healthResult, statsResult, tasksResult, logsResult] = await Promise.all([
        api<LlmSettings>("/admin/api/settings/llm"),
        api<ResearchSettings>("/admin/api/settings/research"),
        api<ApiKeyRow[]>("/admin/api/api-keys"),
        api<Health>("/admin/api/health"),
        api<Stats>("/admin/api/stats"),
        api<Task[]>("/admin/api/tasks"),
        api<LogRow[]>("/admin/api/logs")
      ]);
      setLlm({ ...emptyLlmSettings, ...llmResult, providers: llmResult.providers ?? [] });
      setResearch(researchResult);
      setApiKeys(keysResult);
      setHealth(healthResult);
      setStats(statsResult);
      setTasks(tasksResult);
      setLogs(logsResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const totals = stats.totals;
  const healthIcon = health?.status === "ok" ? CheckCircle2 : TriangleAlert;
  const HealthIcon = healthIcon;

  async function logout() {
    await api("/admin/api/logout", { method: "POST" }).catch(() => undefined);
    onLogout();
  }

  return (
    <main className="min-h-screen bg-muted/20">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold tracking-normal">agentic-web-research</h1>
            <p className="text-sm text-muted-foreground">{me.email}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => void refresh()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </Button>
            <Button variant="ghost" onClick={() => void logout()}>
              <LogOut className="h-4 w-4" />
              Logout
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-6 py-6">
        {error ? <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">{error}</div> : null}

        <section className="grid gap-4 md:grid-cols-4">
          <Metric icon={Activity} label="Tasks total" value={String(totals?.total_tasks ?? 0)} />
          <Metric icon={CheckCircle2} label="Completed" value={String(totals?.completed_tasks ?? 0)} />
          <Metric icon={TriangleAlert} label="Failed" value={String(totals?.failed_tasks ?? 0)} />
          <Metric icon={HealthIcon} label="Health" value={health?.status ?? "unknown"} />
        </section>

        <Tabs defaultValue="settings" className="mt-6">
          <TabsList className="flex w-full justify-start overflow-x-auto md:w-auto">
            <TabsTrigger value="settings">
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </TabsTrigger>
            <TabsTrigger value="keys">
              <KeyRound className="mr-2 h-4 w-4" />
              API keys
            </TabsTrigger>
            <TabsTrigger value="test">
              <FlaskConical className="mr-2 h-4 w-4" />
              Test
            </TabsTrigger>
            <TabsTrigger value="docs">
              <BookOpen className="mr-2 h-4 w-4" />
              Docs
            </TabsTrigger>
            <TabsTrigger value="health">
              <Server className="mr-2 h-4 w-4" />
              Health
            </TabsTrigger>
            <TabsTrigger value="activity">
              <Activity className="mr-2 h-4 w-4" />
              Activity
            </TabsTrigger>
          </TabsList>

          <TabsContent value="settings">
            <div className="grid gap-4 lg:grid-cols-2">
              <LlmProvidersForm llm={llm} refresh={refresh} />
              <ResearchSettingsForm research={research} setResearch={setResearch} refresh={refresh} />
            </div>
          </TabsContent>

          <TabsContent value="keys">
            <ApiKeys keys={apiKeys} refresh={refresh} newKey={newKey} setNewKey={setNewKey} />
          </TabsContent>

          <TabsContent value="test">
            <ResearchTestPanel research={research} onFinished={refresh} />
          </TabsContent>

          <TabsContent value="docs">
            <DocsPanel />
          </TabsContent>

          <TabsContent value="health">
            <Card>
              <CardHeader>
                <CardTitle>Service health</CardTitle>
                <CardDescription>Runtime checks for dependencies and configuration.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Latency</TableHead>
                      <TableHead>Message</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(health?.checks ?? []).map((check) => (
                      <TableRow key={check.name}>
                        <TableCell className="font-medium">{check.name}</TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(check.status)}>{check.status}</Badge>
                        </TableCell>
                        <TableCell>{check.latencyMs ? `${check.latencyMs} ms` : "-"}</TableCell>
                        <TableCell className="text-muted-foreground">{check.message ?? "-"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="activity">
            <div className="grid gap-4 xl:grid-cols-2">
              <TasksTable tasks={tasks} />
              <LogsTable logs={logs} />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}

function Metric({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tracking-normal">{value}</p>
        </div>
        <Icon className="h-5 w-5 text-muted-foreground" />
      </CardContent>
    </Card>
  );
}

function LlmProvidersForm({ llm, refresh }: { llm: LlmSettings; refresh: () => Promise<void> }) {
  const [createDraft, setCreateDraft] = useState<LlmProviderDraft>(() => providerToDraft());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<LlmProviderDraft>(() => providerToDraft());
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const activeProvider = useMemo(
    () => llm.providers.find((provider) => provider.id === llm.activeProviderId),
    [llm.activeProviderId, llm.providers]
  );
  const editingProvider = editingId ? llm.providers.find((provider) => provider.id === editingId) : undefined;

  function startEditing(provider: PublicLlmProvider) {
    setEditingId(provider.id);
    setEditDraft(providerToDraft(provider));
    setFormError("");
  }

  async function createProvider(event: React.FormEvent) {
    event.preventDefault();
    setSavingAction("create");
    setFormError("");
    try {
      await api("/admin/api/settings/llm/providers", {
        method: "POST",
        body: JSON.stringify(draftToPayload(createDraft))
      });
      setCreateDraft(providerToDraft());
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to create provider");
    } finally {
      setSavingAction(null);
    }
  }

  async function updateProvider(event: React.FormEvent) {
    event.preventDefault();
    if (!editingId) return;
    setSavingAction(`update:${editingId}`);
    setFormError("");
    try {
      await api(`/admin/api/settings/llm/providers/${encodeURIComponent(editingId)}`, {
        method: "PUT",
        body: JSON.stringify(draftToPayload(editDraft))
      });
      setEditingId(null);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to update provider");
    } finally {
      setSavingAction(null);
    }
  }

  async function setActive(providerId: string) {
    setSavingAction(`active:${providerId}`);
    setFormError("");
    try {
      await api("/admin/api/settings/llm/active", {
        method: "PUT",
        body: JSON.stringify({ providerId })
      });
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to set active provider");
    } finally {
      setSavingAction(null);
    }
  }

  async function deleteProvider(provider: PublicLlmProvider) {
    if (provider.id === llm.activeProviderId) {
      setFormError("Cannot delete the active provider. Activate another provider first.");
      return;
    }
    if (!window.confirm(`Delete provider "${provider.name}"?`)) return;

    setSavingAction(`delete:${provider.id}`);
    setFormError("");
    try {
      await api(`/admin/api/settings/llm/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      if (editingId === provider.id) setEditingId(null);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to delete provider");
    } finally {
      setSavingAction(null);
    }
  }

  return (
    <Card className="lg:col-span-1">
      <CardHeader>
        <CardTitle>OpenAI-compatible providers</CardTitle>
        <CardDescription>
          Manage one or more model providers. Research uses the active provider{activeProvider ? `: ${activeProvider.name}` : ""}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {formError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {formError}
          </div>
        ) : null}

        <div className="space-y-3">
          <div className="text-sm font-medium">Configured providers</div>
          {llm.providers.length ? (
            <div className="space-y-3">
              {llm.providers.map((provider) => {
                const isActive = provider.id === llm.activeProviderId;
                return (
                  <div key={provider.id} className="rounded-md border bg-muted/20 p-3">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="font-medium">{provider.name}</div>
                          {isActive ? <Badge>Active</Badge> : null}
                          {Object.keys(provider.headers).length ? (
                            <Badge variant="outline">{Object.keys(provider.headers).length} headers</Badge>
                          ) : null}
                        </div>
                        <div className="break-all text-sm text-muted-foreground">{provider.endpoint}</div>
                        <div className="text-sm text-muted-foreground">Model: {provider.model}</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isActive || savingAction === `active:${provider.id}`}
                          onClick={() => void setActive(provider.id)}
                        >
                          {savingAction === `active:${provider.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                          Use
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => startEditing(provider)}>
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={isActive || savingAction === `delete:${provider.id}`}
                          onClick={() => void deleteProvider(provider)}
                        >
                          {savingAction === `delete:${provider.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
              No providers configured. Create one below to enable research.
            </div>
          )}
        </div>

        {editingId && editingProvider ? (
          <div className="rounded-md border p-4">
            <div className="mb-4">
              <div className="font-medium">Edit provider</div>
              <div className="text-sm text-muted-foreground">
                Edit the provider endpoint, model, output limit, and headers. Secret-bearing headers are blank; leave them blank to keep stored values.
              </div>
            </div>
            <ProviderDraftForm
              draft={editDraft}
              setDraft={setEditDraft}
              onSubmit={updateProvider}
              submitLabel="Save provider"
              saving={savingAction === `update:${editingId}`}
              onCancel={() => setEditingId(null)}
            />
          </div>
        ) : null}

        <div className="rounded-md border p-4">
          <div className="mb-4">
            <div className="font-medium">Create provider</div>
            <div className="text-sm text-muted-foreground">Add a new OpenAI-compatible endpoint and optional custom headers.</div>
          </div>
          <ProviderDraftForm
            draft={createDraft}
            setDraft={setCreateDraft}
            onSubmit={createProvider}
            submitLabel="Create provider"
            saving={savingAction === "create"}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function ProviderDraftForm({
  draft,
  setDraft,
  onSubmit,
  submitLabel,
  saving,
  onCancel
}: {
  draft: LlmProviderDraft;
  setDraft: (draft: LlmProviderDraft) => void;
  onSubmit: (event: React.FormEvent) => void;
  submitLabel: string;
  saving: boolean;
  onCancel?: () => void;
}) {
  return (
    <form className="space-y-4" onSubmit={(event) => void onSubmit(event)}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name">
          <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </Field>
        <Field label="Model">
          <Input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
        </Field>
      </div>
      <Field label="Endpoint/Base URL">
        <Input value={draft.endpoint} onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })} />
      </Field>
      <Field label="Max output tokens">
        <Input
          type="number"
          min="256"
          value={draft.maxOutputTokens}
          onChange={(event) => setDraft({ ...draft, maxOutputTokens: Number(event.target.value) })}
        />
      </Field>
      <HeadersEditor entries={draft.headers} onChange={(headers) => setDraft({ ...draft, headers })} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={saving || !draft.name.trim() || !draft.endpoint.trim() || !draft.model.trim()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function HeadersEditor({ entries, onChange }: { entries: HeaderEntry[]; onChange: (entries: HeaderEntry[]) => void }) {
  function updateEntry(id: string, patch: Partial<HeaderEntry>) {
    onChange(entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  }

  const duplicateNames = entries.reduce<Set<string>>((duplicates, entry, index) => {
    const normalized = entry.name.trim().toLowerCase();
    if (!normalized) return duplicates;
    if (entries.findIndex((candidate) => candidate.name.trim().toLowerCase() === normalized) !== index) {
      duplicates.add(normalized);
    }
    return duplicates;
  }, new Set());

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>Headers</Label>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...entries, createHeaderEntry()])}>
          Add Header
        </Button>
      </div>
      {entries.length ? (
        <div className="space-y-2">
          {entries.map((entry) => {
            const normalized = entry.name.trim().toLowerCase();
            const isDuplicate = normalized ? duplicateNames.has(normalized) : false;
            const isSecret = isSecretHeaderName(entry.name);
            return (
              <div key={entry.id} className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <Input
                  value={entry.name}
                  placeholder="Header name"
                  className={isDuplicate ? "border-destructive" : undefined}
                  onChange={(event) => updateEntry(entry.id, { name: event.target.value })}
                />
                <Input
                  type={isSecret ? "password" : "text"}
                  value={entry.value}
                  placeholder={isSecret ? "Stored secret; enter replacement" : "Header value"}
                  onChange={(event) => updateEntry(entry.id, { value: event.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Delete header"
                  onClick={() => onChange(entries.filter((candidate) => candidate.id !== entry.id))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            );
          })}
          {duplicateNames.size ? <p className="text-sm text-destructive">Duplicate header names are not allowed.</p> : null}
        </div>
      ) : (
        <p className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">No custom headers.</p>
      )}
    </div>
  );
}

function ResearchSettingsForm({
  research,
  setResearch,
  refresh
}: {
  research: ResearchSettings;
  setResearch: (settings: ResearchSettings) => void;
  refresh: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    await api("/admin/api/settings/research", { method: "PUT", body: JSON.stringify(research) });
    await refresh();
    setSaving(false);
  }

  function numberField(key: keyof ResearchSettings, min: number, max?: number) {
    return (
      <Input
        type="number"
        min={min}
        max={max}
        value={Number(research[key])}
        onChange={(event) => setResearch({ ...research, [key]: Number(event.target.value) })}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Research limits</CardTitle>
        <CardDescription>Default task limits. Requests may lower or override selected limits within server bounds.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Concurrency">{numberField("maxConcurrency", 1, 8)}</Field>
            <Field label="Depth">{numberField("maxDepth", 1, 8)}</Field>
            <Field label="Max pages">{numberField("maxPages", 1, 32)}</Field>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Task timeout ms">{numberField("timeoutMs", 5000, 300000)}</Field>
            <Field label="Page timeout ms">{numberField("pageTimeoutMs", 3000, 60000)}</Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={research.allowPrivateNetworks}
              onChange={(event) => setResearch({ ...research, allowPrivateNetworks: event.target.checked })}
            />
            Allow private network page rendering
          </label>
          <Button type="submit" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save research settings
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ResearchTestPanel({ research, onFinished }: { research: ResearchSettings; onFinished: () => Promise<void> }) {
  const [query, setQuery] = useState("Summarize the latest stable Bun release and cite sources.");
  const [maxConcurrency, setMaxConcurrency] = useState(Math.min(research.maxConcurrency, 2));
  const [maxDepth, setMaxDepth] = useState(Math.min(research.maxDepth, 2));
  const [maxPages, setMaxPages] = useState(Math.min(research.maxPages, 4));
  const [timeoutMs, setTimeoutMs] = useState(Math.min(research.timeoutMs, 120000));
  const [events, setEvents] = useState<ResearchStreamEvent[]>([]);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Array<{ url: string; title?: string; used?: boolean }>>([]);
  const [running, setRunning] = useState(false);
  const [streamError, setStreamError] = useState("");

  useEffect(() => {
    setMaxConcurrency(Math.min(research.maxConcurrency, 2));
    setMaxDepth(Math.min(research.maxDepth, 2));
    setMaxPages(Math.min(research.maxPages, 4));
    setTimeoutMs(Math.min(research.timeoutMs, 120000));
  }, [research.maxConcurrency, research.maxDepth, research.maxPages, research.timeoutMs]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setRunning(true);
    setEvents([]);
    setAnswer("");
    setSources([]);
    setStreamError("");

    try {
      await streamSse(
        "/admin/api/research-test",
        {
          method: "POST",
          body: JSON.stringify({ query, maxConcurrency, maxDepth, maxPages, timeoutMs })
        },
        (message) => {
          const streamEvent = asStreamEvent(message);
          setEvents((current) => [...current, streamEvent].slice(-200));

          if (streamEvent.type === "answer_delta" && typeof streamEvent.payload.text === "string") {
            setAnswer((current) => current + streamEvent.payload.text);
          }

          if (streamEvent.type === "source") {
            const nextSources = coerceSources(streamEvent.payload.sources);
            if (nextSources.length) setSources(nextSources);
          }

          if (streamEvent.type === "final") {
            if (typeof streamEvent.payload.answer === "string") setAnswer(streamEvent.payload.answer);
            const nextSources = coerceSources(streamEvent.payload.sources);
            if (nextSources.length) setSources(nextSources);
          }

          if (streamEvent.type === "error" && typeof streamEvent.payload.message === "string") {
            setStreamError(streamEvent.payload.message);
          }
        }
      );
    } catch (err) {
      setStreamError(err instanceof Error ? err.message : "Research test failed");
    } finally {
      setRunning(false);
      await onFinished();
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Test research agent</CardTitle>
          <CardDescription>
            Send a prompt from the admin session and watch the same SSE events clients receive from the public API.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={(event) => void submit(event)}>
            <Field label="Prompt">
              <Textarea
                rows={6}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Ask the agent to research a topic..."
              />
            </Field>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Max pages">
                <Input
                  type="number"
                  min={1}
                  max={research.maxPages}
                  value={maxPages}
                  onChange={(event) => setMaxPages(Number(event.target.value))}
                />
              </Field>
              <Field label="Max depth">
                <Input
                  type="number"
                  min={1}
                  max={research.maxDepth}
                  value={maxDepth}
                  onChange={(event) => setMaxDepth(Number(event.target.value))}
                />
              </Field>
              <Field label="Concurrency">
                <Input
                  type="number"
                  min={1}
                  max={research.maxConcurrency}
                  value={maxConcurrency}
                  onChange={(event) => setMaxConcurrency(Number(event.target.value))}
                />
              </Field>
              <Field label="Timeout ms">
                <Input
                  type="number"
                  min={5000}
                  max={research.timeoutMs}
                  step={1000}
                  value={timeoutMs}
                  onChange={(event) => setTimeoutMs(Number(event.target.value))}
                />
              </Field>
            </div>
            {streamError ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                {streamError}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={running || !query.trim()}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {running ? "Researching" : "Run test"}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={running || (!events.length && !answer && !streamError)}
                onClick={() => {
                  setEvents([]);
                  setAnswer("");
                  setSources([]);
                  setStreamError("");
                }}
              >
                Clear
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Live answer</CardTitle>
            <CardDescription>Answer deltas are appended as the model streams.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="min-h-40 whitespace-pre-wrap rounded-md border bg-background p-4 text-sm">
              {answer || <span className="text-muted-foreground">The streamed answer will appear here.</span>}
            </div>
            {sources.length ? (
              <div className="mt-4 space-y-2">
                <div className="text-sm font-medium">Sources</div>
                <ul className="space-y-2 text-sm">
                  {sources.map((source) => (
                    <li key={source.url} className="rounded-md border bg-muted/30 p-2">
                      <a className="font-medium text-primary underline-offset-4 hover:underline" href={source.url} target="_blank" rel="noreferrer">
                        {source.title || source.url}
                      </a>
                      {source.title ? <div className="break-all text-xs text-muted-foreground">{source.url}</div> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Event stream</CardTitle>
            <CardDescription>Search, render, agent, source, final, and error events.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-[32rem] space-y-2 overflow-y-auto rounded-md border bg-background p-3">
              {events.length ? (
                events.map((event, index) => <StreamEventCard key={`${event.at ?? "event"}-${index}`} event={event} />)
              ) : (
                <p className="text-sm text-muted-foreground">Events will appear here while the request is running.</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StreamEventCard({ event }: { event: ResearchStreamEvent }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant={statusVariant(event.type)}>{event.type}</Badge>
        {event.at ? <span className="text-xs text-muted-foreground">{fmtDate(event.at)}</span> : null}
        {event.taskId ? <span className="text-xs text-muted-foreground">task {event.taskId.slice(0, 8)}</span> : null}
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
        {stringifyPayload(event.payload)}
      </pre>
    </div>
  );
}

function DocsPanel() {
  const baseUrl = typeof window === "undefined" ? "http://localhost:8080" : window.location.origin;
  const researchCurl = `export AWR_BASE_URL="${baseUrl}"
export AWR_API_KEY="awr_..."

curl -N "$AWR_BASE_URL/v1/research" \
  -H "Authorization: Bearer $AWR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What changed in the latest stable Bun release?",
    "maxPages": 4,
    "maxDepth": 2,
    "maxConcurrency": 2,
    "timeoutMs": 120000
  }'`;
  const minimalCurl = `curl -N "${baseUrl}/v1/research" \
  -H "Authorization: Bearer awr_..." \
  -H "Content-Type: application/json" \
  -d '{"query":"Compare RAG and web research agents"}'`;
  const loginCurl = `curl -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"change-me-now"}' \
  "${baseUrl}/admin/api/login"

curl -b cookies.txt "${baseUrl}/admin/api/health"`;
  const sseExample = `: connected

event: search_started
data: {"type":"search_started","taskId":"...","at":"...","payload":{"query":"..."}}

event: answer_delta
data: {"type":"answer_delta","taskId":"...","at":"...","payload":{"text":"The answer..."}}

event: final
data: {"type":"final","taskId":"...","at":"...","payload":{"answer":"...","sources":[...]}}`;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Public research API</CardTitle>
          <CardDescription>Use an API key from the API keys tab. The response is Server-Sent Events.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CodeBlock title="Full request" code={researchCurl} />
          <CodeBlock title="Minimal request" code={minimalCurl} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Request body</CardTitle>
          <CardDescription>Only query is required. Optional limits can lower or override configured defaults.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">query</TableCell>
                <TableCell>string</TableCell>
                <TableCell className="text-muted-foreground">Required, 1-2000 characters.</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">maxPages</TableCell>
                <TableCell>number</TableCell>
                <TableCell className="text-muted-foreground">1-32 rendered pages.</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">maxDepth</TableCell>
                <TableCell>number</TableCell>
                <TableCell className="text-muted-foreground">1-8 navigation depth.</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">maxConcurrency</TableCell>
                <TableCell>number</TableCell>
                <TableCell className="text-muted-foreground">1-8 concurrent page renders.</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">timeoutMs</TableCell>
                <TableCell>number</TableCell>
                <TableCell className="text-muted-foreground">5000-300000 task timeout.</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>SSE event types</CardTitle>
          <CardDescription>Each event has type, taskId, at, and payload fields.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {["search_started", "search_result", "page_fetch_started", "page_fetch_finished", "agent_thought", "answer_delta", "source", "final", "error"].map((event) => (
              <Badge key={event} variant={statusVariant(event)}>{event}</Badge>
            ))}
          </div>
          <CodeBlock title="SSE shape" code={sseExample} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Admin API examples</CardTitle>
          <CardDescription>Useful for checking a deployment from a terminal.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CodeBlock title="Login and health check" code={loginCurl} />
          <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
            API keys are only shown once when created. Create one in the API keys tab, copy it, then use it as a Bearer token for public requests.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
        <div className="text-sm font-medium">{title}</div>
        <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(code)}>
          <Copy className="h-4 w-4" />
          Copy
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed"><code>{code}</code></pre>
    </div>
  );
}

function ApiKeys({
  keys,
  refresh,
  newKey,
  setNewKey
}: {
  keys: ApiKeyRow[];
  refresh: () => Promise<void>;
  newKey: string | null;
  setNewKey: (value: string | null) => void;
}) {
  const [name, setName] = useState("");

  async function createKey(event: React.FormEvent) {
    event.preventDefault();
    const created = await api<{ key: string }>("/admin/api/api-keys", {
      method: "POST",
      body: JSON.stringify({ name })
    });
    setNewKey(created.key);
    setName("");
    await refresh();
  }

  async function revoke(id: string) {
    await api(`/admin/api/api-keys/${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>Keys authenticate public research API calls.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form className="flex flex-col gap-2 md:flex-row" onSubmit={(event) => void createKey(event)}>
          <Input placeholder="Key name" value={name} onChange={(event) => setName(event.target.value)} />
          <Button type="submit" disabled={!name.trim()}>
            <KeyRound className="h-4 w-4" />
            Create
          </Button>
        </form>
        {newKey ? (
          <div className="rounded-md border bg-muted/40 p-3">
            <div className="mb-2 text-sm font-medium">New key</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-background px-2 py-1 text-xs">{newKey}</code>
              <Button variant="outline" size="icon" onClick={() => void navigator.clipboard.writeText(newKey)} aria-label="Copy key">
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Prefix</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="font-medium">{key.name}</TableCell>
                <TableCell>{key.prefix}</TableCell>
                <TableCell>{fmtDate(key.created_at)}</TableCell>
                <TableCell>{fmtDate(key.last_used_at)}</TableCell>
                <TableCell>
                  <Badge variant={key.revoked_at ? "destructive" : "secondary"}>{key.revoked_at ? "revoked" : "active"}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  {!key.revoked_at ? (
                    <Button variant="ghost" size="icon" onClick={() => void revoke(key.id)} aria-label="Revoke key">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function TasksTable({ tasks }: { tasks: Task[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent tasks</CardTitle>
        <CardDescription>Latest research requests and outcomes.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Query</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((task) => (
              <TableRow key={task.id}>
                <TableCell className="max-w-80 truncate font-medium">{task.query}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
                </TableCell>
                <TableCell>{fmtDate(task.created_at)}</TableCell>
                <TableCell className="max-w-64 truncate text-muted-foreground">{task.error ?? "-"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function LogsTable({ logs }: { logs: LogRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Service logs</CardTitle>
        <CardDescription>Recent administrative and service events.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Level</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((log) => (
              <TableRow key={log.id}>
                <TableCell>
                  <Badge variant={statusVariant(log.level)}>{log.level}</Badge>
                </TableCell>
                <TableCell className="max-w-96 truncate font-medium">{log.message}</TableCell>
                <TableCell>{fmtDate(log.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = label.toLowerCase().replace(/\W+/g, "-");
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

