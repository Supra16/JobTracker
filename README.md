# Instagram Story Job Monitor

Watches one creator's Instagram Stories, archives each link-sticker URL and its job page in `data/jobs.sqlite`, classifies the link, and sends Telegram alerts. Setup and design notes live in [INSTAGRAM_JOB_MONITOR_BUILD_GUIDE.md](INSTAGRAM_JOB_MONITOR_BUILD_GUIDE.md).

## Job feed export (optional)

When enabled, the monitor builds `feed/listings.json` after each poll cycle. It fetches `origin`'s default branch, and if the file differs from the one there, pushes a new commit on top that changes only that file. It uses the git credentials already on this machine, so other job trackers can read the feed from GitHub. It never commits to, checks out, or writes files in your working copy, and never force-pushes. The export is off by default, and with it off the monitor behaves as before.

### Turn it on

1. Run the monitor from a git clone whose `origin` is the GitHub repo. Any checked-out branch works.
2. Confirm `git push` works from that clone without a prompt (Git Credential Manager or an SSH key).
3. Add to `.env`:

   ```env
   FEED_EXPORT_ENABLED=true
   # Optional: days a listing stays in the feed after the monitor first saw it (default 14).
   FEED_RETENTION_DAYS=14
   ```

4. Restart the monitor. It logs `Feed export: enabled (14-day retention)`.

### What the feed contains

Only links the classifier marks as **Job Listing**. Events, forms, programs, job-search pages, resources and unknown links stay out. Each job URL appears once, newest first, and drops out `FEED_RETENTION_DAYS` days after its earliest sighting, across every link that led to it.

```json
{
  "company_name": "Acme",
  "title": "Software Engineering Intern, Fall 2026",
  "url": "https://job-boards.greenhouse.io/acme/jobs/456",
  "locations": ["San Francisco, CA", "Remote"],
  "date_posted": 1793664000,
  "active": true,
  "terms": ["Fall 2026"],
  "level": "intern",
  "source": "instagram:zero2sudo"
}
```

`locations` comes from the job page when the monitor fetched it: the page's schema.org JobPosting location (JSON-LD or microdata), or, for Greenhouse job boards, the board's public job API. Each entry is `City, ST` in the US, `City, Country` elsewhere, or `Remote`. A location that names only a country is left out, and the list is empty when the page gave none or was fetched before the monitor recorded locations.

`date_posted` is the first sighting in Unix seconds. `terms` and `level` appear only when the classifier knows them. `source` comes from `INSTAGRAM_CREATOR_USERNAME`.

### The feed is public in a public repo

Anyone can read `feed/listings.json` and its commit history in a public repository. It holds company, role title, job URL, job location, first-seen time and the creator's handle. It holds no Story screenshots, page text, Instagram session data or Telegram settings.

### When it does not push

The monitor logs `Feed export skipped: ...` and tries again next cycle when:

- `origin`'s default branch is unknown (run `git remote set-head origin --auto`);
- someone pushed to the default branch between the fetch and the push, so GitHub rejected the push. The next cycle fetches again and rebuilds the commit.

If the archive query returns 1000 rows (its fixed cap), the monitor logs `Feed export: feed query hit the 1000-row cap; ...` each cycle. The least recently seen listings may be missing from the feed.

A failed fetch or push, such as no network, logs `Feed export failed; it will retry next cycle`. No manual `git pull` is needed.

### Recommended poll interval

Stories last 24 hours, so the feed does not need a five-minute poll. Consider `POLL_INTERVAL_SECONDS=1800` to `3600` (30 to 60 minutes). The default stays 300.
