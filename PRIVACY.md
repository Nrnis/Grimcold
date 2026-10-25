# Privacy

Grimcold is a free, unofficial fan tool. It is not affiliated with Gaijin Entertainment or
Targem Games. It only reads the game's files and never changes them.

## What the app sends, and when

Nothing. The releases have no report address built in, so they never send anything: **Bug report**
copies the technical details for you and opens GitHub's issue form, where you decide what to post.

A build made with a report address (the manual's "Donations and bug reports") can also send one
anonymous technical report when you click **Bug report → Send report** or the crash dialog's **Send
report**, and crashes and errors by themselves once you tick **Send crash reports automatically** (off
until you tick it; you can untick it again at any time). Bug report shows those buttons only in such
a build. A report contains:

- the app's version, Windows version, CPU, memory, graphics cards and their drivers, WebView2's
  version and the display's size and scale
- where in the app you were (the view, the map or part open) and the view's on/off and number settings
- the last 40 steps taken in the app: which button or tab was clicked, by its label, or that a list
  row was (never the text you typed, and never what a list row says)
- the errors seen this session, and the last lines of the app's log
- after a crash of the app itself, a minidump: the state of the program's threads when it crashed
  (only what a stack trace needs: no other memory, and no folders its parts were loaded from)
- a random install ID, so that crashes can be counted per installation

The app takes your Windows user folder, user name and computer name out of everything it sends or
logs, the minidump included. A report contains no files, models or game data, no name, no email, and no text you typed.

## Where it goes

In a build with a report address, reports go to [Sentry](https://sentry.io) (EU data region,
Frankfurt), where they are kept for 30 days, without IP addresses, and used only to fix bugs. A build
without one, like the releases, sends nothing at all: Bug report only copies the details for you to
paste.

**Bug report → Open the bug report form** opens GitHub's issue form in your browser. What you write
there is public, under your own GitHub account, and covered by GitHub's own terms.

## The app's own files

The log (`logs\`, 5 files of 1 MB at most) and the crashes (`crashes\`) are in the app's data folder,
`%LOCALAPPDATA%\Grimcold`. While the app runs, `crashes\running.json` marks that it is open, so that
an end without a crash report is still noticed at the next start. **Bug report → Open log folder**
opens `logs\`; `crashes\` is next to it. Deleting either is always fine.

## Donations

The Donations page only opens the platforms' own pages (GitHub Sponsors, Ko-fi, Liberapay ...) in
your browser. The app never sees payment details. A donation is a voluntary gift and unlocks nothing.

## Your rights

To have a report deleted, open an issue or a private security advisory on GitHub and quote the
report's event ID (shown in the log). You may also complain to your country's data protection
authority.
