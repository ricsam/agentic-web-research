import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  Save,
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
import { api, fmtDate } from "@/lib/api";

type Me = { email: string };
type LlmSettings = {
  endpoint: string;
  model: string;
  apiKey?: string;
  hasApiKey?: boolean;
  headers: Record<string, string>;
  temperature: number;
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

const emptyLlm: LlmSettings = {
  endpoint: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  headers: {},
  temperature: 0.2,
  maxOutputTokens: 4096
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
  const [llm, setLlm] = useState<LlmSettings>(emptyLlm);
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
      setLlm({ ...emptyLlm, ...llmResult, apiKey: "" });
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
              <LlmSettingsForm llm={llm} setLlm={setLlm} refresh={refresh} />
              <ResearchSettingsForm research={research} setResearch={setResearch} refresh={refresh} />
            </div>
          </TabsContent>

          <TabsContent value="keys">
            <ApiKeys keys={apiKeys} refresh={refresh} newKey={newKey} setNewKey={setNewKey} />
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

function LlmSettingsForm({
  llm,
  setLlm,
  refresh
}: {
  llm: LlmSettings;
  setLlm: (llm: LlmSettings) => void;
  refresh: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const headersText = useMemo(() => JSON.stringify(llm.headers ?? {}, null, 2), [llm.headers]);
  const [headersDraft, setHeadersDraft] = useState(headersText);

  useEffect(() => setHeadersDraft(headersText), [headersText]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    const headers = headersDraft.trim() ? JSON.parse(headersDraft) : {};
    await api("/admin/api/settings/llm", {
      method: "PUT",
      body: JSON.stringify({ ...llm, headers, apiKey: llm.apiKey || undefined })
    });
    await refresh();
    setSaving(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>LLM endpoint</CardTitle>
        <CardDescription>OpenAI-compatible endpoint used by the research agent.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <Field label="Endpoint">
            <Input value={llm.endpoint} onChange={(event) => setLlm({ ...llm, endpoint: event.target.value })} />
          </Field>
          <Field label="Model">
            <Input value={llm.model} onChange={(event) => setLlm({ ...llm, model: event.target.value })} />
          </Field>
          <Field label={llm.hasApiKey ? "API key replacement" : "API key"}>
            <Input
              type="password"
              value={llm.apiKey ?? ""}
              placeholder={llm.hasApiKey ? "Existing key stored" : ""}
              onChange={(event) => setLlm({ ...llm, apiKey: event.target.value })}
            />
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Temperature">
              <Input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={llm.temperature}
                onChange={(event) => setLlm({ ...llm, temperature: Number(event.target.value) })}
              />
            </Field>
            <Field label="Max output tokens">
              <Input
                type="number"
                min="256"
                value={llm.maxOutputTokens}
                onChange={(event) => setLlm({ ...llm, maxOutputTokens: Number(event.target.value) })}
              />
            </Field>
          </div>
          <Field label="Extra headers JSON">
            <Textarea value={headersDraft} onChange={(event) => setHeadersDraft(event.target.value)} />
          </Field>
          <Button type="submit" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save LLM settings
          </Button>
        </form>
      </CardContent>
    </Card>
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

