# Jeeves identity (personal — never shared)

The only truly personal facts Jeeves needs. Every project config references these, so you set
them once. Fill the first four fields and delete the angle brackets; leave the fifth blank.

- **gh login:** `<your-github-username>`      # e.g. octocat — confirm with `gh api user -q .login`
- **Jira email:** `<you@company.com>`         # the address Jira knows you by (assignee / QA assignee)
- **display name:** `<Firstname>`             # names your personal Confluence plans folder: Plans > <display name>
- **dev root:** `<~/Dev>`                      # where your repo checkouts live; a project's local path
                                              #   defaults to <dev-root>/<repo-name>
- **confluence plans folder id:** `<blank>`   # leave blank — the loop finds-or-creates Plans > <display name>
                                              #   on first plan and caches the id here

