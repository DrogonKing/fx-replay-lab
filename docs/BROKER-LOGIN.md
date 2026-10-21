# Why the Log in button "does not work"

It works. It was talking to nothing, and saying so in a way nobody could act on.

## What the button actually does

```
[form] → IPC bridge:login → POST {url}/login → Python bridge → mt5.initialize(login, password, server)
```

The Python bridge is a **separate process the user starts themselves**. The app cannot start it: it
is a Windows-only Python script that imports the `MetaTrader5` package, and no part of the desktop
app can create that for you.

## The failure, before

```
could not reach the bridge: fetch failed
```

That is Node's wrapper for *any* connection problem — refused, DNS, timeout, reset. The real reason
is in `cause.code` and the code threw it away. So the user learns nothing:

- is the bridge supposed to be running? (not stated anywhere near the button)
- how would I start it? (nowhere in the UI)
- is my URL wrong? (indistinguishable from all of the above)

A working button plus a missing prerequisite plus an unhelpful message is indistinguishable from a
broken button. That is the bug.

## The failure, after

```
nothing is listening at http://127.0.0.1:8765 — the bridge is not running.
Start it with: python bridge/mt5-bridge.py (on the Windows machine where MetaTrader
is installed), then press Log in again.
```

`explainFetchFailure()` maps the stable cause codes to sentences that name the next action:

| cause code | message |
|---|---|
| `ECONNREFUSED` | nothing is listening at … the bridge is not running. Start it with … |
| `ENOTFOUND` / `EAI_AGAIN` | … does not resolve — the bridge runs on 127.0.0.1 or localhost |
| `ETIMEDOUT` / `UND_ERR_CONNECT_TIMEOUT` | … did not answer in time; the bridge may be starting |
| `ECONNRESET` / `UND_ERR_SOCKET` | the connection closed mid-request; check the bridge console |

Plus a how-to block in the broker panel, next to the button, with the three steps and the exact
command in a copyable code element.

## What was verified, and how

**The IPC path works.** Called from the renderer against a stub bridge:

```
window.fxlab.testBridge('http://127.0.0.1:18790')
  → {ok: true, health: {connected: true, symbols: 5}, bars: 500, firstOpen: 1.10432}

window.fxlab.bridgeLogin({url, login, password, server})
  → {ok: true, account: "Stub-Demo #10000001 (demo)", symbols: 5}
```

**The button works end to end.** Real click on the real button, bridge on the app's default port,
no URL editing:

```
probe before      : ok — connected, 5 symbols, 500 bars
after Log in      : ok — "logged in — Stub-Demo #10000001 (demo)"
password cleared  : true
```

**The failure is now actionable**, with no bridge running at all (the state every new user is in):

```
verdict               : fail
stillSaysFetchFailed  : false
namesTheProblem       : true
saysHowToStart        : true
passwordLeaked        : false
```

## What still cannot be verified from this machine

The `MetaTrader5` package is `win_amd64` only, so **no real broker login has ever been executed
here**. Everything above proves the HTTP and IPC layers. `mt5.initialize(login=…, password=…,
server=…)` against a real ICMarkets demo account has not been run, by me or by any test in this
repo. If it fails, the bridge returns MetaTrader's own error text and the panel shows it verbatim —
but that call itself is unproven.

Recommended path, and the one that avoids the app ever seeing a password: **log the terminal in by
hand first**, then just probe. The login fields exist for headless setups where that is impossible.

## Credentials

Passwords typed into this panel go to `127.0.0.1` over loopback only, are held in memory for a
single request, are scrubbed from every error string, and are cleared from the field on success.
They are never written to disk.

A password sent over a chat window is compromised regardless of any of that. Rotate it.
