import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  BookOpen,
  Boxes,
  CheckCircle2,
  Copy,
  ExternalLink,
  FlaskConical,
  Github,
  Globe2,
  KeyRound,
  Layers3,
  Loader2,
  Lock,
  Search,
  Server,
  ShieldCheck,
  Terminal,
  Zap
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fmtDate, streamSse, type SseMessage } from "@/lib/api";

const eventTypes = [
  "search_started",
  "search_result",
  "page_fetch_started",
  "page_fetch_finished",
  "agent_thought",
  "answer_delta",
  "source",
  "final",
  "error"
];

type DemoConfig = {
  enabled: boolean;
  rateLimit: {
    max: number;
    windowMs: number;
  };
  defaults: {
    maxConcurrency: number;
    maxDepth: number;
    maxPages: number;
    timeoutMs: number;
  };
};

type ResearchStreamEvent = {
  type: string;
  taskId?: string;
  at?: string;
  payload: Record<string, unknown>;
};

type Source = {
  url: string;
  title?: string;
  used?: boolean;
};

const defaultDemoConfig: DemoConfig = {
  enabled: true,
  rateLimit: {
    max: 5,
    windowMs: 600000
  },
  defaults: {
    maxConcurrency: 2,
    maxDepth: 2,
    maxPages: 4,
    timeoutMs: 120000
  }
};

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

function statusVariant(status: string) {
  if (status === "ok" || status === "completed" || status === "final") return "secondary" as const;
  if (status === "down" || status === "failed" || status === "error") return "destructive" as const;
  return "outline" as const;
}

function stringifyPayload(value: unknown) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function formatDuration(ms: number) {
  if (ms < 60000) return `${Math.round(ms / 1000)} seconds`;
  return `${Math.round(ms / 60000)} minutes`;
}

export default function Website() {
  const baseUrl = typeof window === "undefined" ? "https://agentic-web-research.example.com" : window.location.origin;

  return (
    <main className="min-h-screen overflow-hidden bg-background">
      <SiteNav />
      <Hero baseUrl={baseUrl} />
      <ResearchDemo />
      <DocsSection baseUrl={baseUrl} />
      <HelmSection baseUrl={baseUrl} />
      <ArchitectureSection />
      <Footer />
    </main>
  );
}

function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <a className="flex items-center gap-2 font-semibold" href="#top">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Search className="h-4 w-4" />
          </div>
          agentic-web-research
        </a>
        <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
          <a className="hover:text-foreground" href="#demo">Demo</a>
          <a className="hover:text-foreground" href="#docs">Docs</a>
          <a className="hover:text-foreground" href="/llms.txt" target="_blank" rel="noreferrer">llms.txt</a>
          <a className="hover:text-foreground" href="#helm">Helm</a>
          <a className="hover:text-foreground" href="#architecture">Architecture</a>
        </nav>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" className="hidden sm:inline-flex">
            <a href="https://github.com/ricsam/agentic-web-research" target="_blank" rel="noreferrer">
              <Github className="h-4 w-4" />
              GitHub
            </a>
          </Button>
          <Button asChild variant="outline">
            <a href="/admin">
              <KeyRound className="h-4 w-4" />
              Admin
            </a>
          </Button>
        </div>
      </div>
    </header>
  );
}

function Hero({ baseUrl }: { baseUrl: string }) {
  return (
    <section id="top" className="relative border-b bg-gradient-to-br from-background via-background to-secondary/60 px-6 py-20 md:py-28">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,hsl(var(--accent)/0.16),transparent_32rem)]" />
      <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] lg:items-center">
        <div>
          <Badge variant="outline" className="mb-5 bg-background/80">Self-hosted research API for AI agents</Badge>
          <h1 className="max-w-4xl text-4xl font-semibold tracking-tight md:text-6xl">
            Search, render, reason, and stream cited web research from your own infrastructure.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
            agentic-web-research bundles SearXNG search, Playwright page rendering, readable Markdown extraction, and OpenAI-compatible model orchestration behind one REST API and admin console.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild className="h-11 px-5 text-base">
              <a href="#demo">
                Try the live demo
                <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
            <Button asChild className="h-11 px-5 text-base" variant="outline">
              <a href="#helm">
                Install with Helm
                <Boxes className="h-4 w-4" />
              </a>
            </Button>
            <Button asChild className="h-11 px-5 text-base" variant="outline">
              <a href="/llms.txt" target="_blank" rel="noreferrer">
                LLM docs
                <Bot className="h-4 w-4" />
              </a>
            </Button>
          </div>
          <div className="mt-8 grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
            <FeaturePill icon={ShieldCheck} title="Self hosted" text="Keep keys and browsing in your cluster." />
            <FeaturePill icon={Zap} title="SSE streaming" text="Follow every search, render, and answer delta." />
            <FeaturePill icon={Lock} title="Admin controls" text="Manage providers, keys, and limits." />
          </div>
        </div>
        <Card className="border-primary/10 bg-background/80 shadow-2xl shadow-primary/5 backdrop-blur">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Terminal className="h-5 w-5" />
              API quick start
            </CardTitle>
            <CardDescription>Issue one authenticated request and receive typed Server-Sent Events.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <CodeBlock
              title="Research request"
              code={`curl -N "${baseUrl}/v1/research" \\
  -H "Authorization: Bearer awr_..." \\
  -H "Content-Type: application/json" \\
  -d '{"query":"Compare agentic web research with classic RAG","maxPages":4}'`}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <MiniStat label="Search" value="SearXNG" />
              <MiniStat label="Render" value="Playwright" />
              <MiniStat label="Models" value="OpenAI API compatible" />
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function FeaturePill({ icon: Icon, title, text }: { icon: React.ElementType; title: string; text: string }) {
  return (
    <div className="rounded-lg border bg-background/70 p-3">
      <Icon className="mb-2 h-4 w-4 text-foreground" />
      <div className="font-medium text-foreground">{title}</div>
      <div>{text}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium">{value}</div>
    </div>
  );
}

function ResearchDemo() {
  const [config, setConfig] = useState<DemoConfig>(defaultDemoConfig);
  const [query, setQuery] = useState("What are the most important recent improvements in the Vercel AI SDK? Include sources.");
  const [maxPages, setMaxPages] = useState(defaultDemoConfig.defaults.maxPages);
  const [events, setEvents] = useState<ResearchStreamEvent[]>([]);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/v1/demo/config")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(response.statusText)))
      .then((nextConfig: DemoConfig) => {
        setConfig(nextConfig);
        setMaxPages(nextConfig.defaults.maxPages);
      })
      .catch(() => undefined);
  }, []);

  const limitText = useMemo(() => {
    return `${config.rateLimit.max} runs per ${formatDuration(config.rateLimit.windowMs)}`;
  }, [config.rateLimit.max, config.rateLimit.windowMs]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setRunning(true);
    setEvents([]);
    setAnswer("");
    setSources([]);
    setError("");

    try {
      await streamSse(
        "/v1/demo/research",
        {
          method: "POST",
          body: JSON.stringify({
            query,
            maxPages,
            maxDepth: config.defaults.maxDepth,
            maxConcurrency: config.defaults.maxConcurrency,
            timeoutMs: config.defaults.timeoutMs
          })
        },
        (message) => {
          const streamEvent = asStreamEvent(message);
          setEvents((current) => [...current, streamEvent].slice(-120));

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
            setError(streamEvent.payload.message);
          }
        }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demo research failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section id="demo" className="border-b px-6 py-16 md:py-24">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 max-w-3xl">
          <Badge variant="outline" className="mb-3">Live demo</Badge>
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Watch the research loop happen in real time.</h2>
          <p className="mt-3 text-muted-foreground">
            The public demo endpoint is intentionally rate limited ({limitText}) and capped to small research jobs. Configure an LLM provider in the admin console before enabling it for visitors.
          </p>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="h-5 w-5" />
                Research prompt
              </CardTitle>
              <CardDescription>Submits to <code>/v1/demo/research</code> without requiring an API key.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={(event) => void submit(event)}>
                <Field label="Question">
                  <Textarea rows={6} value={query} onChange={(event) => setQuery(event.target.value)} />
                </Field>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Max pages">
                    <Input
                      type="number"
                      min={1}
                      max={config.defaults.maxPages}
                      value={maxPages}
                      onChange={(event) => setMaxPages(Number(event.target.value))}
                    />
                  </Field>
                  <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                    <div className="font-medium text-foreground">Demo limits</div>
                    <div>Depth {config.defaults.maxDepth}, concurrency {config.defaults.maxConcurrency}, timeout {formatDuration(config.defaults.timeoutMs)}.</div>
                  </div>
                </div>
                {error ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                    {error}
                  </div>
                ) : null}
                {!config.enabled ? (
                  <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
                    Public demo research is disabled on this deployment.
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={running || !query.trim() || !config.enabled}>
                    {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    {running ? "Researching" : "Run demo"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={running || (!events.length && !answer && !error)}
                    onClick={() => {
                      setEvents([]);
                      setAnswer("");
                      setSources([]);
                      setError("");
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
                <CardTitle className="flex items-center gap-2">
                  <BookOpen className="h-5 w-5" />
                  Streamed answer
                </CardTitle>
                <CardDescription>Answer deltas are appended as the agent gathers evidence.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="min-h-40 whitespace-pre-wrap rounded-md border bg-background p-4 text-sm">
                  {answer || <span className="text-muted-foreground">The answer will appear here once the model starts streaming.</span>}
                </div>
                {sources.length ? <SourcesList sources={sources} /> : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5" />
                  Event stream
                </CardTitle>
                <CardDescription>Typed SSE events expose search results, page renders, model tool calls, sources, and errors.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-[32rem] space-y-2 overflow-y-auto rounded-md border bg-background p-3">
                  {events.length ? (
                    events.map((event, index) => <StreamEventCard key={`${event.at ?? "event"}-${index}`} event={event} />)
                  ) : (
                    <p className="text-sm text-muted-foreground">Events will appear here while research is running.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </section>
  );
}

function SourcesList({ sources }: { sources: Source[] }) {
  return (
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
      <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
        {stringifyPayload(event.payload)}
      </pre>
    </div>
  );
}

function DocsSection({ baseUrl }: { baseUrl: string }) {
  return (
    <section id="docs" className="border-b bg-muted/20 px-6 py-16 md:py-24">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 max-w-3xl">
          <Badge variant="outline" className="mb-3 bg-background">Documentation</Badge>
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Everything agents need for cited web research.</h2>
          <p className="mt-3 text-muted-foreground">
            Use API keys for production clients, then stream events to show progress or pipe final answers into your own agent workflows. A plain-text LLM reference is also available at <a className="font-medium text-primary underline-offset-4 hover:underline" href="/llms.txt" target="_blank" rel="noreferrer">/llms.txt</a>.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Public API</CardTitle>
              <CardDescription>Authenticated research endpoint.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <CodeBlock
                title="POST /v1/research"
                code={`curl -N "${baseUrl}/v1/research" \\
  -H "Authorization: Bearer awr_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "query": "What changed in the latest stable Bun release?",
    "maxPages": 4,
    "maxDepth": 2,
    "maxConcurrency": 2,
    "timeoutMs": 120000
  }'`}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <DocCard icon={KeyRound} title="API keys" text="Create and revoke Bearer tokens in the admin console." />
                <DocCard icon={Globe2} title="Safe rendering" text="Private network rendering is disabled by default." />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>SSE event contract</CardTitle>
              <CardDescription>Every event includes type, taskId, at, and payload.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {eventTypes.map((event) => (
                  <Badge key={event} variant={statusVariant(event)}>{event}</Badge>
                ))}
              </div>
              <CodeBlock
                title="Stream shape"
                code={`event: search_started
data: {"type":"search_started","taskId":"...","at":"...","payload":{"query":"..."}}

event: answer_delta
data: {"type":"answer_delta","taskId":"...","at":"...","payload":{"text":"The answer..."}}

event: final
data: {"type":"final","taskId":"...","at":"...","payload":{"answer":"...","sources":[...]}}`}
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}

function DocCard({ icon: Icon, title, text }: { icon: React.ElementType; title: string; text: string }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <Icon className="mb-2 h-4 w-4" />
      <div className="font-medium">{title}</div>
      <div className="text-sm text-muted-foreground">{text}</div>
    </div>
  );
}

function HelmSection({ baseUrl }: { baseUrl: string }) {
  return (
    <section id="helm" className="border-b px-6 py-16 md:py-24">
      <div className="mx-auto grid max-w-7xl gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:items-start">
        <div>
          <Badge variant="outline" className="mb-3">Helm chart</Badge>
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Install from the public GitHub Pages chart repo.</h2>
          <p className="mt-3 text-muted-foreground">
            Chart 0.2.2 deploys the app plus optional Postgres and SearXNG. The public image <code className="break-all font-mono text-xs">ghcr.io/ricsam/agentic-web-research:f7d1fd2a184ba2610b1673d808f232dfdc368adf</code> needs no image pull secret.
          </p>
          <div className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
            <a className="rounded-lg border p-3 hover:bg-muted/30" href="https://ricsam.github.io/agentic-web-research/index.yaml" target="_blank" rel="noreferrer">
              <div className="flex items-center gap-2 font-medium"><ExternalLink className="h-4 w-4" /> Chart index</div>
              <div className="mt-1 break-all text-muted-foreground">ricsam.github.io/agentic-web-research/index.yaml</div>
            </a>
            <a className="rounded-lg border p-3 hover:bg-muted/30" href="https://ricsam.github.io/agentic-web-research/agentic-web-research-0.2.2.tgz">
              <div className="flex items-center gap-2 font-medium"><Boxes className="h-4 w-4" /> Package</div>
              <div className="mt-1 text-muted-foreground">agentic-web-research-0.2.2.tgz</div>
            </a>
          </div>
        </div>
        <div className="space-y-4">
          <CodeBlock
            title="Add the repo"
            code={`helm repo add agentic-web-research https://ricsam.github.io/agentic-web-research
helm repo update
helm search repo agentic-web-research`}
          />
          <CodeBlock
            title="Create credentials"
            code={`kubectl create namespace agentic-web-research \\
  --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic agentic-web-research-secrets \\
  --namespace agentic-web-research \\
  --from-literal=APP_SECRET='<long-random-value>' \\
  --from-literal=ADMIN_PASSWORD='<admin-password>' \\
  --from-literal=POSTGRES_PASSWORD='<database-password>' \\
  --from-literal=SEARXNG_SECRET='<long-random-value>'`}
          />
          <CodeBlock
            title="Install"
            code={`helm upgrade --install awr agentic-web-research/agentic-web-research \\
  --version 0.2.2 \\
  --namespace agentic-web-research \\
  --set existingSecret=agentic-web-research-secrets \\
  --set env.publicBaseUrl=${baseUrl} \\
  --set env.adminEmail=admin@example.com`}
          />
        </div>
      </div>
    </section>
  );
}

function ArchitectureSection() {
  return (
    <section id="architecture" className="bg-muted/20 px-6 py-16 md:py-24">
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 max-w-3xl">
          <Badge variant="outline" className="mb-3 bg-background">Architecture</Badge>
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">A complete research stack in one open source service.</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <ArchitectureCard icon={Search} title="Search" text="SearXNG metasearch seeds the agent with candidate sources without relying on a single search provider." />
          <ArchitectureCard icon={Server} title="Render" text="Playwright loads pages, then Readability and Turndown produce compact Markdown for model context." />
          <ArchitectureCard icon={Layers3} title="Reason" text="The AI SDK drives OpenAI-compatible providers with tools for page viewing and final result submission." />
          <ArchitectureCard icon={CheckCircle2} title="Operate" text="Fastify, Postgres, admin auth, API keys, health checks, Docker Compose, and Helm are included." />
        </div>
      </div>
    </section>
  );
}

function ArchitectureCard({ icon: Icon, title, text }: { icon: React.ElementType; title: string; text: string }) {
  return (
    <Card>
      <CardHeader>
        <div className="mb-2 grid h-10 w-10 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Icon className="h-5 w-5" />
        </div>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{text}</CardContent>
    </Card>
  );
}

function Footer() {
  return (
    <footer className="border-t px-6 py-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
        <div>agentic-web-research is open source and designed for self-hosting.</div>
        <div className="flex gap-4">
          <a className="hover:text-foreground" href="#docs">Docs</a>
          <a className="hover:text-foreground" href="/llms.txt" target="_blank" rel="noreferrer">llms.txt</a>
          <a className="hover:text-foreground" href="#helm">Helm</a>
          <a className="hover:text-foreground" href="/admin">Admin console</a>
        </div>
      </div>
    </footer>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = label.toLowerCase().replace(/\W+/g, "-");
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
