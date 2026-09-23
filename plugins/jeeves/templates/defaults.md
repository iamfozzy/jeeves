---
reviewCommand: /code-review
seedFiles: <.env>
---

# Jeeves shared defaults

Every project inherits these. A field (bold label) or frontmatter key set in a project's
`project.md` replaces the one here; everything else is inherited. Fill the placeholders; delete a
field you don't use.

## Jira
- **cloudId:** `<cloud-id>` (<site>)           # Atlassian cloudId; the site name in parentheses links tickets
- **plan trigger:** `In Progress`               # the status that surfaces `plan <TICKET>`
- **QA-assignee field:** `<customfield_XXXXX>`  # single-user picker distinct from `assignee`
- **QA columns:** `<Ready For QA>`, `<QA>`      # statuses that count as "in QA"

## Confluence (plan pages)
- **space:** `<SPACE>`
- **Plans parent:** `<Plans>`                   # each user's plans nest under `<Plans> > <display name>`

## GitHub
- **review scope:** `mine`                      # mine = PRs requesting or reviewed by me; repo = also every
                                                #   open non-draft teammate PR (set per project, opt-in)
- **base branches:** `<qa>`, `<develop>`        # `/jeeves:setup --scan` writes the first that exists on
                                                #   origin; none → origin's default branch
