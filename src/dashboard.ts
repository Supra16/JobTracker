import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { JobArchive } from "./archive.js";

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(value));
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Job Link Archive</title>
  <style>
    :root { color-scheme: dark; --bg:#090d16; --panel:#111827; --line:#263247; --muted:#93a4bc; --text:#eef4ff; --accent:#70a5ff; --good:#55d6a7; --warn:#f1b45d; }
    * { box-sizing:border-box; }
    body { margin:0; background:radial-gradient(circle at 15% 0,#17233a 0,transparent 35%),var(--bg); color:var(--text); font:14px/1.5 Inter,Segoe UI,system-ui,sans-serif; }
    main { width:min(1400px,calc(100% - 32px)); margin:32px auto 80px; }
    header { display:flex; align-items:end; justify-content:space-between; gap:24px; margin-bottom:22px; }
    h1 { margin:0; font-size:clamp(27px,4vw,42px); letter-spacing:-.04em; }
    header p { margin:6px 0 0; color:var(--muted); }
    .live { display:flex; align-items:center; gap:8px; color:var(--good); white-space:nowrap; }
    .dot { width:9px; height:9px; border-radius:99px; background:var(--good); box-shadow:0 0 14px var(--good); }
    .stats { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; margin-bottom:18px; }
    .stat,.toolbar,.table-wrap { background:color-mix(in srgb,var(--panel) 91%,transparent); border:1px solid var(--line); box-shadow:0 16px 50px rgba(0,0,0,.18); }
    .stat { padding:17px 18px; border-radius:14px; }
    .stat span { display:block; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .stat strong { display:block; margin-top:4px; font-size:25px; }
    .toolbar { display:flex; gap:12px; padding:13px; border-radius:14px; margin-bottom:14px; }
    input,select { min-height:42px; border-radius:9px; border:1px solid var(--line); background:#0b1220; color:var(--text); padding:0 13px; outline:none; }
    input { flex:1; }
    input:focus,select:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(112,165,255,.13); }
    .table-wrap { border-radius:16px; overflow:hidden; }
    table { width:100%; border-collapse:collapse; }
    th { padding:12px 15px; text-align:left; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; background:#0e1524; }
    td { padding:14px 15px; border-top:1px solid var(--line); vertical-align:top; }
    tbody tr { cursor:pointer; transition:background .15s ease; }
    tbody tr:hover { background:#172136; }
    .title { font-weight:650; max-width:480px; }
    .company { font-size:16px; font-weight:700; }
    .term { color:var(--accent); background:rgba(112,165,255,.08); }
    .kind { color:#c9a7ff; background:rgba(201,167,255,.08); }
    .confidence-high { color:var(--good); }.confidence-medium { color:var(--warn); }.confidence-low { color:var(--muted); }
    .classification { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
    .evidence { margin:10px 0 0; padding-left:20px; color:#c8d4e7; }
    .host,.muted { color:var(--muted); }
    .host { font-size:12px; margin-top:3px; }
    .pill { display:inline-flex; align-items:center; border:1px solid currentColor; border-radius:99px; padding:3px 8px; font-size:11px; }
    .pill.good { color:var(--good); }.pill.warn { color:var(--warn); }
    .empty { padding:52px; color:var(--muted); text-align:center; }
    dialog { width:min(980px,calc(100% - 28px)); max-height:90vh; padding:0; border:1px solid var(--line); border-radius:18px; background:#0d1422; color:var(--text); box-shadow:0 30px 100px rgba(0,0,0,.65); }
    dialog::backdrop { background:rgba(3,6,12,.78); backdrop-filter:blur(5px); }
    .dialog-head { position:sticky; top:0; z-index:2; display:flex; justify-content:space-between; gap:20px; padding:20px 22px; border-bottom:1px solid var(--line); background:#0d1422; }
    .dialog-head h2 { margin:0; font-size:21px; }.dialog-body { padding:22px; }
    button { border:1px solid var(--line); border-radius:9px; background:#172136; color:var(--text); padding:8px 12px; cursor:pointer; }
    a { color:var(--accent); overflow-wrap:anywhere; }
    .description,.body-text,.story { border:1px solid var(--line); border-radius:12px; background:#0a101c; padding:15px; margin-top:14px; }
    .body-text { max-height:230px; overflow:auto; white-space:pre-wrap; color:#c8d4e7; }
    .story-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; margin-top:12px; }
    .story { margin:0; min-width:0; }.story img { width:100%; max-height:360px; object-fit:contain; background:#05070c; border-radius:8px; margin-top:10px; }
    .story-text { max-height:125px; overflow:auto; white-space:pre-wrap; color:#c8d4e7; margin-top:9px; }
    @media(max-width:850px){ .stats{grid-template-columns:repeat(2,1fr)} th:nth-child(5),td:nth-child(5),th:nth-child(6),td:nth-child(6){display:none} header{align-items:start;flex-direction:column} }
  </style>
</head>
<body>
<main>
  <header><div><h1>Job Link Archive</h1><p>Every external link observed in the monitored Instagram Stories.</p></div><div class="live"><span class="dot"></span>Local archive</div></header>
  <section class="stats">
    <div class="stat"><span>Links</span><strong id="s-links">0</strong></div>
    <div class="stat"><span>Stories</span><strong id="s-stories">0</strong></div>
    <div class="stat"><span>Fetched</span><strong id="s-fetched">0</strong></div>
    <div class="stat"><span>Fetch failed</span><strong id="s-failed">0</strong></div>
    <div class="stat"><span>Last 24 hours</span><strong id="s-recent">0</strong></div>
  </section>
  <section class="toolbar">
    <input id="search" type="search" placeholder="Search company, title, description, URL, creator, or Story text…">
    <select id="kind"><option value="all">All content types</option><option>Job Listing</option><option>Event</option><option>Form</option><option>Program</option><option>Job Search</option><option>Resource</option><option>Unknown</option></select>
    <select id="status"><option value="all">All fetch states</option><option value="fetched">Page fetched</option><option value="failed">Needs review</option></select>
  </section>
  <section class="table-wrap"><table><thead><tr><th>Company</th><th>Content</th><th>Role / opportunity</th><th>Term</th><th>Confidence</th><th>First seen</th></tr></thead><tbody id="rows"></tbody></table><div id="empty" class="empty" hidden>No archived links match this view.</div></section>
</main>
<dialog id="detail"><div class="dialog-head"><h2 id="d-title">Link details</h2><button id="close">Close</button></div><div class="dialog-body" id="detail-body"></div></dialog>
<script>
  const byId = id => document.getElementById(id);
  const rows = byId('rows'), empty = byId('empty'), detail = byId('detail');
  const date = value => value ? new Date(value).toLocaleString() : '—';
  const el = (tag, className, text) => { const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=text; return node; };
  async function refreshStats(){ const s=await fetch('/api/stats').then(r=>r.json()); byId('s-links').textContent=s.links; byId('s-stories').textContent=s.stories; byId('s-fetched').textContent=s.fetched; byId('s-failed').textContent=s.fetchFailed; byId('s-recent').textContent=s.seenLast24Hours; }
  async function refresh(){
    const query=new URLSearchParams({search:byId('search').value,status:byId('status').value,kind:byId('kind').value});
    const jobs=await fetch('/api/jobs?'+query).then(r=>r.json()); rows.replaceChildren(); empty.hidden=jobs.length>0;
    for(const job of jobs){
      const tr=document.createElement('tr'); tr.addEventListener('click',()=>showDetail(job.id));
      const company=el('td'); company.append(el('div','company',job.companyName)); company.append(el('div','host',new URL(job.finalUrl).hostname));
      const kind=el('td'); kind.append(el('span','pill kind',job.contentKind));
      const position=el('td'); position.append(el('div','title',job.roleTitle)); position.append(el('div','host',job.opportunityType));
      const term=el('td'); term.append(el('span','pill term',job.recruitingTerm));
      const confidence=el('td'); confidence.append(el('span','pill confidence-'+job.confidence.toLowerCase(),job.confidence));
      tr.append(company,kind,position,term,confidence,el('td','muted',date(job.firstSeenAt))); rows.append(tr);
    }
  }
  async function showDetail(id){
    const job=await fetch('/api/jobs/'+id).then(r=>r.json()); byId('d-title').textContent=job.companyName+' · '+job.contentKind; const body=byId('detail-body'); body.replaceChildren();
    body.append(el('div','muted','Archive ID #'+job.id));
    body.append(el('h3',null,job.roleTitle));
    const classification=el('div','classification');
    classification.append(el('span','pill kind',job.contentKind),el('span','pill',job.opportunityType),el('span','pill term',job.recruitingTerm),el('span','pill confidence-'+job.confidence.toLowerCase(),job.confidence+' confidence'));
    body.append(classification);
    if(job.evidence.length){ const list=el('ul','evidence'); for(const reason of job.evidence) list.append(el('li',null,reason)); body.append(list); }
    body.append(el('div','host','Raw page title: '+job.title));
    const link=el('a',null,job.finalUrl); link.href=job.finalUrl; link.target='_blank'; link.rel='noreferrer'; body.append(link);
    if(job.requestedUrl!==job.finalUrl) body.append(el('div','host','Originally captured as '+job.requestedUrl));
    body.append(el('p','muted','First seen '+date(job.firstSeenAt)+' · Last seen '+date(job.lastSeenAt)+' · '+job.occurrenceCount+' observations'));
    if(job.description) body.append(el('div','description',job.description));
    const bodyText=el('div','body-text',job.bodyText||'No job-page text was available.'); body.append(bodyText);
    body.append(el('h3',null,'Source Stories'));
    const grid=el('div','story-grid');
    for(const source of job.sources){
      const card=el('article','story'); card.append(el('strong',null,'@'+source.creatorUsername)); card.append(el('div','muted',source.storyKey+' · '+date(source.discoveredAt)));
      const storyLink=el('a',null,'Open Story source'); storyLink.href=source.storyUrl; storyLink.target='_blank'; storyLink.rel='noreferrer'; card.append(storyLink);
      const raw=el('a',null,source.rawUrl); raw.href=source.rawUrl; raw.target='_blank'; raw.rel='noreferrer'; card.append(raw);
      if(source.visibleText) card.append(el('div','story-text',source.visibleText));
      const img=el('img'); img.loading='lazy'; img.alt='Captured Story frame'; img.src='/api/stories/'+encodeURIComponent(source.storyKey)+'/screenshot'; card.append(img); grid.append(card);
    }
    body.append(grid); detail.showModal();
  }
  let timer; byId('search').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(refresh,250)}); byId('status').addEventListener('change',refresh); byId('kind').addEventListener('change',refresh); byId('close').addEventListener('click',()=>detail.close()); detail.addEventListener('click',e=>{if(e.target===detail)detail.close()});
  refreshStats(); refresh(); setInterval(()=>{refreshStats();refresh()},30000);
</script>
</body></html>`;
}

export async function startDashboard(
  archive: JobArchive,
  port: number,
  artifactDirectory: string
): Promise<Server> {
  const artifactRoot = path.resolve(artifactDirectory).toLowerCase();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method !== "GET") return json(response, 405, { error: "Method not allowed" });

      if (url.pathname === "/api/stats") return json(response, 200, archive.getStats());
      if (url.pathname === "/api/jobs") {
        return json(response, 200, archive.listJobs(
          url.searchParams.get("search") ?? "",
          url.searchParams.get("status") ?? "all",
          250,
          url.searchParams.get("kind") ?? "all"
        ));
      }

      const jobMatch = url.pathname.match(/^\/api\/jobs\/(\d+)$/);
      if (jobMatch) {
        const job = archive.getJob(Number(jobMatch[1]));
        return job ? json(response, 200, job) : json(response, 404, { error: "Not found" });
      }

      const screenshotMatch = url.pathname.match(/^\/api\/stories\/(.+)\/screenshot$/);
      if (screenshotMatch) {
        const story = archive.getStory(decodeURIComponent(screenshotMatch[1]));
        if (!story?.screenshotPath) return json(response, 404, { error: "Screenshot not found" });
        const resolved = path.resolve(story.screenshotPath);
        if (!resolved.toLowerCase().startsWith(`${artifactRoot}${path.sep}`)) {
          return json(response, 403, { error: "Invalid screenshot path" });
        }
        const image = await readFile(resolved);
        response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=300" });
        return response.end(image);
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return response.end(dashboardHtml());
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
