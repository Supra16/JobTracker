# Instagram Story Job Monitor

Watches one creator's Instagram Stories, archives each link-sticker URL and its job page in `data/jobs.sqlite`, classifies the link, and sends Telegram alerts. Setup and design notes live in [INSTAGRAM_JOB_MONITOR_BUILD_GUIDE.md](INSTAGRAM_JOB_MONITOR_BUILD_GUIDE.md).

## Job feed export (optional)

When enabled, the monitor writes `feed/listings.json` after each poll cycle. If the content changed, it commits only that file and pushes it to `origin`'s default branch with the git credentials already on this machine, so other job trackers can read the feed from GitHub. The export is off by default, and with it off the monitor behaves as before.

### Turn it on

1. Run the monitor from a git clone whose `origin` is the GitHub repo, checked out on the default branch.
2. Confirm `git push` works from that clone without a prompt (Git Credential Manager or an SSH key).
3. Add to `.env`:

   ```env
   FEED_EXPORT_ENABLED=true
   # Optional: days a listing stays in the feed after the monitor first saw it (default 14).
   FEED_RETENTION_DAYS=14
   ```

4. Restart the monitor. It logs `Feed export: enabled (14-day retention)`.

### What the feed contains

Only links the classifier marks as **Job Listing**. Events, forms, programs, job-search pages, resources and unknown links stay out. Each job URL appears once, newest first, and drops out `FEED_RETENTION_DAYS` days after its first sighting.

```json
{
  "company_name": "Acme",
  "title": "Software Engineering Intern, Fall 2026",
  "url": "https://job-boards.greenhouse.io/acme/jobs/456",
  "locations": [],
  "date_posted": 1793664000,
  "active": true,
  "terms": ["Fall 2026"],
  "level": "intern",
  "source": "instagram:zero2sudo"
}
```

`date_posted` is the first sighting in Unix seconds. `terms` and `level` appear only when the classifier knows them. `source` comes from `INSTAGRAM_CREATOR_USERNAME`.

### The feed is public in a public repo

Anyone can read `feed/listings.json` and its commit history in a public repository. It holds company, role title, job URL, first-seen time and the creator's handle. It holds no Story screenshots, page text, Instagram session data or Telegram settings.

### When it does not push

The monitor logs `Feed export skipped: ...` and tries again next cycle when:

- the clone is on another branch (it writes the file but does not commit it);
- the default branch has unpushed commits besides the feed (push them yourself; the monitor never publishes them).

If the archive query returns 1000 rows (its fixed cap), the monitor logs `Feed export: feed query hit the 1000-row cap; ...` each cycle. Listings first seen longest ago may be missing from the feed.

A failed push, such as no network or new commits on GitHub, logs `Feed export failed; it will retry next cycle`. After new commits land on GitHub, run `git pull` and the next cycle pushes.

### Recommended poll interval

Stories last 24 hours, so the feed does not need a five-minute poll. Consider `POLL_INTERVAL_SECONDS=1800` to `3600` (30 to 60 minutes). The default stays 300.
