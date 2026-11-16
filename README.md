# In the Margins

**Read 20 or 30 books at once, and lose none of them.**

In the Margins is an Obsidian plugin for a big pile of books in progress. It does not count pages. It records one thing: the last day you picked up each book. When a book goes untouched for too long, the plugin tells you.

Each book is a plain Markdown note with properties. You can read and edit your data without the plugin.

## Start here

1. Install the plugin and turn it on (see [Install](#install)).
2. Click the books icon in the left ribbon. The pile opens.
3. Click **Add book**. Type a title, then click **Add**.
4. When you pick up a book, click **Touched** on its card.

## The pile

The pile shows each book you are reading as a card with its cover.

- **Touched:** one click records today as the last day you read the book. Ten minutes counts.
- **Due and stale:** a book is "due" after 11 days and "stale" after 14 days. You can change both numbers.
- **Pick one of these up next:** a strip at the top shows the books that are due or stale, oldest first. Each book shows your "Why this book" note.
- **How useful is it:** three dots on each card. The levels are *some value*, *useful* and *deeply useful*. Click a dot again to clear it.

Tabs: Reading, Queue, Finished, Set aside, and Topics.

## Add a book

**Add book** opens a short form. Only the title is necessary.

- Choose **Reading now** or **Queue for later**.
- Add the author, the start date (today by default), and topics.
- Add a link to a Bookpile, Goodreads or StoryGraph page.
- Search Open Library for a cover, or paste an image URL.
- Write a few lines in **Why this book**: what drew you to it and what you hope to find.

The plugin makes one note for each book in `Books/`.

## The queue

The queue holds books that you want to read soon. Queued books do not go stale.

- **Start reading** moves the book into the pile and sets today as the start date.
- **Set aside** removes the book without a start.

If "Why this book" is empty when you start a book, the plugin asks once. You can skip the question.

## Close a book

**Close** asks two questions:

1. Did you finish the book, or set it aside?
2. How useful was it?

A text box also takes your final thoughts. The plugin saves them with the date under `## Final thoughts` in the note. **Back to the pile** opens a closed book again.

## Topics

The **Topics** tab manages your topic list. You can add, rename and delete topics. A rename changes every book that uses the topic.

Each topic is a note in `Topics/`. The note lists its books by status and has space for your own notes.

## Connections

- Each book note shows **Connected books**: other books with the same topics.
- To link two books directly, add one book to the `related` property of the other.
- **Draw the connections map** makes `Maps/Connections.canvas`. Topics make a ring. Each book sits between its topics. Colors show stale, due and finished books.

The map is drawn again each time. Make a copy first if you moved items by hand.

## Year-end report

**Year-end report** makes one Markdown note for a year, in `Exports/`. It contains:

- The covers of every book you finished.
- A summary table: finished, set aside, started, still reading, and the average number of days with a book.
- Highlights: your longest book, your quickest finish, your busiest month, your most useful topic, and more.
- Each finished or set-aside book with its cover, dates, usefulness, "Why this book" and final thoughts.
- A table of topics.

Covers use HTML `<img>` tags. They show in Obsidian, on GitHub, and in most newsletter tools.

## Other exports

All exports are Markdown files in `Exports/`.

- **Currently reading:** the pile grouped by topic, plus your queue.
- **Finished and set aside since the last export:** the plugin remembers what it exported before.
- **All data:** a Markdown table and a CSV with every field.

## Show a list in any note

Add an `in-the-margins` code block:

````markdown
```in-the-margins
show: suggestions
```
````

Values for `show`: `suggestions`, `stale`, `reading`, `queue`, `finished`, `set aside`, `topics`, `topic`, `connected`.

- `topic` lists the books of the topic note that contains the block.
- `connected` lists the books that share topics with the book note that contains the block.

## Commands

| Command | Result |
| --- | --- |
| Open the pile | Opens the main view |
| Add a book | Opens the add form |
| Mark this book touched today | Updates the open book |
| Finish or set aside this book | Opens the close form |
| Put this book back in the pile | Opens a closed book again |
| Start reading this book (from the queue) | Moves a queued book into the pile |
| Why this book | Edits "Why this book" for the open book |
| Find a cover for this book | Searches Open Library |
| Year-end report | Makes the report for a year |
| Draw the connections map | Makes the canvas |

The plugin sets no hotkeys.

## Settings

- **Stale after (days):** 14 by default.
- **Warn this many days before:** 3 by default. These books show as suggestions.
- **Suggestions to show:** 4 by default.
- **Open the pile when the vault opens:** on by default.
- **Folders:** Books, Topics, Exports and Maps.

## Book properties

| Property | Values |
| --- | --- |
| `title`, `author` | text |
| `cover`, `link` | URLs |
| `status` | `reading`, `queued`, `finished`, `set aside` |
| `useful` | 1, 2 or 3 |
| `topics`, `related` | lists of links |
| `added`, `started`, `last_touched`, `ended` | dates |

You can edit these properties by hand. The plugin reads them again each time.

## Network use

The plugin connects to [Open Library](https://openlibrary.org) only when you search for a cover. Cover images load from the URL in each note. The plugin has no accounts, no telemetry and no ads. It does not change files outside your vault.

## Install

**Manual install:**

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in `<your vault>/.obsidian/plugins/in-the-margins/`.
3. In Obsidian, open **Settings → Community plugins** and turn on **In the Margins**.

**With BRAT:** add `jenniferlynparsons/in-the-margins` as a beta plugin.

The plugin works on desktop and mobile.

## License

MIT
