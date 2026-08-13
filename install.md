# DVPX Reflector Installation — From Scratch

This guide is written **for someone who has never managed a server**. Copying
and pasting the commands in order is enough. At every step I also wrote down
"what you should see"; if what you see differs from what is written, go straight
to [Troubleshooting](#12-troubleshooting).

Estimated time: **20–30 minutes.**

---

## Contents

1. [What is a reflector and what does it do?](#1-what-is-a-reflector-and-what-does-it-do)
2. [What do you need?](#2-what-do-you-need)
3. [Step 1 — Ask the administrator for a token](#3-step-1--ask-the-administrator-for-a-token)
4. [Step 2 — Connect to the server](#4-step-2--connect-to-the-server)
5. [Step 3 — Install Node.js](#5-step-3--install-nodejs)
6. [Step 4 — Put the DVPX files in place](#6-step-4--put-the-dvpx-files-in-place)
7. [Step 5 — Create config.json](#7-step-5--create-configjson)
8. [Step 6 — Open the ports in the firewall](#8-step-6--open-the-ports-in-the-firewall)
9. [Step 7 — First run (trial)](#9-step-7--first-run-trial)
10. [Step 8 — Install as a service (keep it running)](#10-step-8--install-as-a-service-keep-it-running)
11. [Step 9 — Verify that it works](#11-step-9--verify-that-it-works)
12. [Troubleshooting](#12-troubleshooting)
13. [Daily use: command card](#13-daily-use-command-card)
14. [Updating](#14-updating)
15. [Frequently asked questions](#15-frequently-asked-questions)
16. [Reflector-to-reflector link (shared talkgroups)](#16-reflector-to-reflector-link-shared-talkgroups)
17. [Automatic updates — no SSH (optional)](#17-automatic-updates--no-ssh-optional)

---

## 1. What is a reflector and what does it do?

DVPX consists of two parts:

```
   ┌───────────────────────────────────────────────────┐
   │  DASHBOARD (PANEL)  —  centre of the network,     │
   │                        there is ONLY ONE          │
   │                                                   │
   │  • users, blocking                                │
   │  • creating / disabling talkgroups (TG)           │
   │  • private TG permissions                         │
   │  • reflector approvals and tokens                 │
   │  • the database lives ONLY here                   │
   └──────────────────┬────────────────────────────────┘
                      │  HTTPS + token
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐
   │REFLECTOR│  │REFLECTOR│  │REFLECTOR│   ← this guide installs this one
   │(server) │  │         │  │         │
   └────┬────┘  └─────────┘  └─────────┘
        │ TCP 62070 (signalling) + UDP 62071 (voice)
        ▼
   Digi Voice applications (phone / computer)
```

**A reflector only carries audio.** The dashboard decides who may talk and which
talkgroups are open; the reflector fetches those decisions from the dashboard
and enforces them.

What this means for you:

| | |
|---|---|
| **No database credentials needed** | The reflector never connects to MySQL. All you hold is a single token. |
| **You do not need to install the dashboard** | The dashboard sits at the centre, with the network administrator. |
| **No `npm install`** | The reflector has no external dependencies at all. Just Node.js. |
| **No administrative work** | Creating TGs, blocking users and so on are not yours; they happen in the dashboard. |

---

## 2. What do you need?

### a) A server (VPS)

The minimum requirements really are low:

| | Minimum | Comfortable |
|---|---|---|
| CPU | 1 core | 4 cores |
| RAM | 1 GB | 4 GB |
| Disk | 5 GB | 30 GB |
| Operating system | Ubuntu 22.04 / Debian 12 | Ubuntu 24.04 |
| Node.js | 18 | 20 |

**A STATIC PUBLIC IP ADDRESS IS MANDATORY.** Applications must reach the
reflector directly from the internet; if the address changes, everyone connected
drops. VPS providers give you a static IP by default.

> **Is a VPS required?** No — what matters is not the kind of box but the
> requirements it meets. A **Raspberry Pi 4 / 5** or a similar mini computer
> (Intel NUC, thin client, an old laptop) can be used as long as it meets the
> bar above and can stay up 24/7. If you use a Raspberry Pi, install the 64-bit
> Raspberry Pi OS (Debian based); every command in this guide works unchanged.
> Prefer booting the system from an SSD/USB disk rather than an SD card: under
> constant writes SD cards last months, not years, and they die without warning.
>
> A home internet connection is usually NOT suitable (dynamic IP, NAT, closed
> ports). If you still want to try it at home, you will have to set up port
> forwarding on your router.

### b) A stable address (IP or domain name)

Either you use the IP directly (`203.0.113.10`) or you point a **domain name**
at it (`dvpx.yoursite.com`). **A domain name is better:** if you ever move the
server to another provider you only change the DNS record — you never have to
touch the users' settings.

### c) An API token from the dashboard

The **network administrator** generates this and gives it to you. That is the
next step.

### d) Credentials for connecting to the server

Your provider gives you: the **IP address**, a **username** (usually `root`),
and a **password** or an **SSH key**.

---

## 3. Step 1 — Ask the administrator for a token

Send the network administrator the following information:

```
I would like to run a reflector. Details:

  Server name : DVPX-ANKARA          (any name you like)
  Address     : dvpx.example.com     (IP or domain name)
  TCP port    : 62070                (the port must be 62070)
  UDP port    : 62071                (the port must be 62071)
  Region      : TR
  My callsign / contact: TA1XYZ · mail@example.com
```

In the dashboard the administrator does the following: creates your record with
**Reflectors → New Reflector**, then presses the **⚿** button on your row. The
dashboard shows them a ready-to-use text to send you:

```json
{
  "serverName": "DVPX-ANKARA",
  "bindAddress": "0.0.0.0",
  "tcpPort": 62070,
  "udpPort": 62071,
  "dashboard": {
    "url": "https://dvpx.algsoft.net.tr/reflector.php",
    "token": "dvpx_8f3a91c7e2b45d06a1f8..."
  }
}
```

**Keep this text.** The token is shown in the dashboard **only once**; if it is
lost the administrator has to generate a new one (and the old one becomes
invalid immediately).

> ⚠️ **The token is a password.** If sending it over WhatsApp/e-mail is
> unavoidable, whoever forwards it should delete the message afterwards. Anyone
> holding the token can join the network as a reflector.

---

## 4. Step 2 — Connect to the server

### If you use Windows

On Windows 10/11 PowerShell is enough. **Start → PowerShell**, then open it:

```powershell
ssh root@203.0.113.10
```

(Replace `203.0.113.10` with your own server IP.)

On the first connection it asks the following — type `yes` and press Enter:

```
The authenticity of host '203.0.113.10' can't be established.
Are you sure you want to continue connecting (yes/no)? yes
```

Then it asks for your password. **Nothing appears on screen while you type the
password** — this is normal; type it and press Enter.

### If you use Mac or Linux

Open Terminal and type the same command:

```bash
ssh root@203.0.113.10
```

### How do you know you are connected?

The start of the line turns into something like this:

```
root@vps-12345:~#
```

From now on the commands you type run **on the server**. Every command from
here on is typed in this window.

### First job: update the system

```bash
apt update && apt upgrade -y
```

This may take a few minutes. If at some point a colourful screen asks "which
services should be restarted?", use the Tab key to reach `<Ok>` and press Enter.

---

## 5. Step 3 — Install Node.js

The reflector runs on Node.js. **Version 18 or above** is required.

First check whether it is already installed:

```bash
node --version
```

- If it prints something like `v18.19.0` (the number being greater than or equal
  to 18) → **skip** this step and go to Step 4.
- If it says `command not found`, or the version is lower than 18 → continue.

### Installation (Ubuntu / Debian)

Run the following two commands **in order**:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
```

```bash
sudo apt install -y nodejs
```

### Verify

```bash
node --version
```

**What you should see:** a version number starting with `v20.`. Example:

```
v20.18.1
```

> **Note:** You do **not** need to run `npm install`. The DVPX reflector has no
> external package dependencies at all; it uses Node's own built-in modules.

### Install Git now as well

In the next step we will pull the files from the repository, and `git` does not
come pre-installed on most servers:

```bash
sudo apt install -y git
```

Verify:

```bash
git --version
```

You should see output like `git version 2.x.x`.

---

## 6. Step 4 — Put the DVPX files in place

When we are done the directory structure will look like this:

```
/opt/dvpx-reflector/            ← THIS is where we will work
├── src/                        ← program files
├── tools/                      ← test client
├── package.json
├── config.example.json         ← a sample; you do not need to copy it
├── config.json                 ← YOU will create this (Step 5)
├── dvpx-reflector.service
├── KURULUM.md                  ← the Turkish version of this guide
└── install.md                  ← this file
```

In other words, the **working directory** throughout this guide is always:

```
/opt/dvpx-reflector
```

> **The repository does NOT contain the dashboard** — the published repository is
> the reflector only, and its files sit directly at the root. The dashboard runs
> at the centre of the network, at the network administrator; it is never
> installed on your server.

> **Why exactly this path?** The `dvpx-reflector.service` file that ships with
> the repository uses this path. If you install here you can copy the service
> file **without editing it at all**; if you install somewhere else you have to
> change three of its lines by hand (explained in Step 8).

Now we will bring the DVPX files here. **There are two ways**, pick one.
Installing with Git is **recommended**: updating then comes down to a single
command (Section 14).

### Way A — With Git (recommended)

If Git is not installed, install it first:

```bash
sudo apt install -y git
```

Then clone the repository straight into `/opt/dvpx-reflector`:

```bash
sudo git clone https://github.com/cektor/DVPX.git /opt/dvpx-reflector
```

When cloning is finished, move into the working directory:

```bash
cd /opt/dvpx-reflector
```

> **Do not leave out the path at the end of the command.** If you write it as
> `git clone <url>`, git creates a folder named `DVPX` inside the directory you
> are currently in and the files end up somewhere other than
> `/opt/dvpx-reflector`. Giving the target directory explicitly puts the files
> exactly where we want them — and you do not need `mkdir` either, git creates
> the directory itself.

### Way B — Manual upload (if the files were given to you as a zip)

On your own computer, open a **new PowerShell/Terminal window** (do not close
the SSH window) and, in the directory where the zip file is:

```bash
scp DVPX.zip root@203.0.113.10:/opt/
```

Then go back to the SSH window:

```bash
sudo apt install -y unzip
cd /tmp
sudo unzip /opt/DVPX.zip
ls
```

In the `ls` output you will see the name of the folder that was extracted
(`DVPX`, `DVPX-main` or similar). Use that name in the command below:

```bash
sudo mkdir -p /opt/dvpx-reflector
sudo cp -r /tmp/DVPX/. /opt/dvpx-reflector/
sudo rm -rf /tmp/DVPX /opt/DVPX.zip
cd /opt/dvpx-reflector
```

> The `/.` at the end matters: it copies the **contents** of the folder. Without
> it the files land under `/opt/dvpx-reflector/DVPX/` and none of the paths in
> the following steps will work.

> With a manual installation, updating is manual too. If you installed with Git,
> updating is a single `git pull` command; that is why Way A is recommended.

### Verify

```bash
ls /opt/dvpx-reflector/src/
```

**What you should see:**

```
config.js  control.js  index.js  logger.js  packet.js  peers.js  sessions.js  tcp-server.js  udp-server.js
```

If you do not see these files, the path may be different. Search for it with:

```bash
find / -name "control.js" -path "*reflector*" 2>/dev/null
```

Note down the path that comes up; in the following steps you will use it instead
of `/opt/dvpx-reflector`.

---

## 7. Step 5 — Create config.json

Move into the reflector directory:

```bash
cd /opt/dvpx-reflector
```

Create the file with the `nano` editor:

```bash
nano config.json
```

An empty screen opens. Paste **the text the administrator gave you** here.

- **Pasting in Windows PowerShell:** the **right mouse button**.
- **In the Mac Terminal:** `Cmd + V`.

After pasting, the file should look like this:

```json
{
  "serverName": "DVPX-ANKARA",
  "bindAddress": "0.0.0.0",
  "tcpPort": 62070,
  "udpPort": 62071,
  "dashboard": {
    "url": "https://dvpx.algsoft.net.tr/reflector.php",
    "token": "dvpx_8f3a91c7e2b45d06a1f8..."
  }
}
```

**To save:**

1. `Ctrl + O` (the letter O, not zero) → Enter (it asks for the file name,
   confirm it)
2. `Ctrl + X` (exit)

### Hide the file

The token is a password; other users should not be able to read it:

```bash
chmod 600 config.json
```

### Verify

```bash
cat config.json
```

The content you wrote should appear. Common mistakes in JSON:

| Mistake | Correct |
|---|---|
| An extra comma after the last line | `"token": "..."` — **no** comma |
| Missing quotation mark | Every string starts and ends with `"` |
| Smart quotes (`"` `"`) | It must be the straight quote `"` (copy-paste can introduce these) |

### What the settings mean

| Setting | What it does | Should I change it? |
|---|---|---|
| `serverName` | The name shown in the logs. If the dashboard reports its own name, that one is used. | No |
| `bindAddress` | `0.0.0.0` = listen on all network interfaces | No |
| `tcpPort` | Signalling port (login, TG selection) | Must be the **same** as in the dashboard |
| `udpPort` | Voice port | Must be the **same** as in the dashboard |
| `dashboard.url` | The dashboard address | Exactly as the administrator gave it |
| `dashboard.token` | Your identity key | Exactly as the administrator gave it |

Optional extra settings (if you do not write them, the defaults are used):

```json
  "limits": {
    "maxSessions": 500,
    "maxSubscriptionsPerUser": 8,
    "packetsPerSecond": 100,
    "sessionTimeoutSec": 90,
    "registerTimeoutSec": 60,
    "maxPayloadBytes": 400
  },
  "logLevel": "info",
  "logCalls": true,
  "statsEverySec": 60
```

`maxSessions` is your own decision based on your server's capacity: for a VPS
with 512 MB of RAM, 500 is a comfortable upper limit. While hunting a problem
you can temporarily set `logLevel` to `"debug"`.

---

## 8. Step 6 — Open the ports in the firewall

If you **skip this step the reflector runs but nobody can connect.** This is the
most common mistake.

Ports that must be opened:

| Port | Protocol | What for |
|---|---|---|
| 62070 | **TCP** | Signalling (login, TG selection) |
| 62071 | **UDP** | Voice — **the reflector-to-reflector link uses this port too** |
| 22 | TCP | SSH — your own connection, do not close it! |

> 🔗 **You do NOT need to open an extra port for the reflector-to-reflector
> link.** Audio exchange with the other reflectors happens over the same UDP
> port 62071. Just make sure that port is open in **both the inbound and the
> outbound** direction — with `ufw`, outbound traffic is open by default anyway.

### Ubuntu / Debian (ufw)

```bash
ufw allow 22/tcp
ufw allow 62070/tcp
ufw allow 62071/udp
ufw --force enable
```

> ⚠️ Make sure you run `ufw allow 22/tcp` **before** the `ufw enable` command.
> Otherwise your own SSH connection is cut and you cannot get into the server.

Verify:

```bash
ufw status
```

**What you should see:**

```
Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
62070/tcp                  ALLOW       Anywhere
62071/udp                  ALLOW       Anywhere
```

### The firewall in your provider's panel

This is a separate layer and **this is the place most people skip.** With
providers such as Hetzner, AWS, Oracle Cloud, Azure and Google Cloud there is a
second firewall in front of the server.

In your provider's web panel look for: *Firewall*, *Security Group*, *Network
Rules*. Add the same rules there as well:

- Inbound **TCP 62070** → allow
- Inbound **UDP 62071** → allow

**If you use Oracle Cloud** you additionally have to fix the iptables rules
inside the server (Oracle images close everything by default):

```bash
iptables -I INPUT -p tcp --dport 62070 -j ACCEPT
iptables -I INPUT -p udp --dport 62071 -j ACCEPT
apt install -y iptables-persistent
netfilter-persistent save
```

---

## 9. Step 7 — First run (trial)

Before installing it as a service, let us run it by hand and see that
everything is in order.

```bash
cd /opt/dvpx-reflector
node src/index.js
```

> **To find out the version** there is no need to run the reflector; this
> command prints only the version number without reading `config.json` (it can
> be captured from scripts with `$(node src/index.js -v)`):
>
> ```bash
> node src/index.js -v          # ->  1.0.2
> node src/index.js -h          # short help
> ```

### Successful output looks like this

```
  ██████  ██    ██ ██████  ██   ██   DVPX Reflector
  ██   ██ ██    ██ ██   ██  ██ ██    Digi Voice Protocol eXtended
  ██   ██ ██    ██ ██████    ███     TCP signalling + UDP voice
  ██   ██  ██  ██  ██       ██ ██    version 1.0.2
  ██████    ████   ██      ██   ██   −·· ···− ·−· −··−

[main ] version: 1.0.2
[main ] server name: DVPX-ANKARA
[main ] config file: /opt/dvpx-reflector/config.json
[main ] limits: 500 sessions, 8 TG/user, 100 pkt/s, 90s timeout
[contr] dashboard: https://dvpx.algsoft.net.tr/reflector.php
[contr] token: dvpx_8f3a91c7… (45 karakter / chars)
[contr] politika guncellendi: 4 TG, 0 engelli, 0 ozel TG yetkisi (damga a1b2c3d4)
[main ] panel: #3 "DVPX-ANKARA" (uygulamalara dagitiliyor)
[udp  ] voice listening on 0.0.0.0:62071
[tcp  ] signalling listening on 0.0.0.0:62070
[main ] DVPX reflector is ready. 73!
```

The three lines you are looking for:

1. `politika guncellendi: N TG` → **the dashboard connection works.**
2. `voice listening` and `signalling listening` → **the ports were opened.**
3. `uygulamalara dagitiliyor` (published to apps) → **users will see you in the
   list.**

If there is a problem you will see an error instead of this output — look the
message up in the table in the [Troubleshooting](#12-troubleshooting) section.

### Stop the trial

Press `Ctrl + C`. You will see:

```
[main ] SIGINT received, shutting down...
[contr] kapanis bildirimi gonderildi / final report sent
[main ] bye. 73!
```

> At this point the reflector has **stopped**. A program you started with
> `Ctrl + C` in the foreground also stops when you close the SSH window. For it
> to run continuously you need the next step.

---

## 10. Step 8 — Install as a service (keep it running)

Now we will turn the reflector into a system service. This way:

- it runs even if you close the SSH window,
- it starts by itself if the server reboots,
- if it crashes it restarts by itself within 5 seconds.

### 1) Create an unprivileged user

Do not run the reflector as `root`. If a security hole appears, its impact
should stay limited:

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin dvpx
```

> If it says "user 'dvpx' already exists" that is fine, it is already there.

### 2) Set the file permissions

```bash
chown -R dvpx:dvpx /opt/dvpx-reflector
chmod 600 /opt/dvpx-reflector/config.json
```

### 3) Put the service file in place

The ready-made file is in the repository:

```bash
sudo cp /opt/dvpx-reflector/dvpx-reflector.service /etc/systemd/system/
```

If you used the path from Step 4 (`/opt/dvpx-reflector`) there is
**nothing to change in this file** — the service file already uses that path.

**If you installed somewhere else** you have to edit the file:

```bash
sudo nano /etc/systemd/system/dvpx-reflector.service
```

Replace the path on the following three lines with your own path, then `Ctrl+O`,
Enter, `Ctrl+X`:

```
WorkingDirectory=/opt/dvpx-reflector
Documentation=file:/opt/dvpx-reflector/KURULUM.md
ReadWritePaths=/opt/dvpx-reflector
```

Also, if `node` lives somewhere else, correct the `ExecStart` line. You can find
where Node is like this:

```bash
which node
```

### 4) Start the service

```bash
systemctl daemon-reload
systemctl enable dvpx-reflector
systemctl start dvpx-reflector
```

### 5) Check its status

```bash
systemctl status dvpx-reflector
```

**What you should see** — a green `active (running)`:

```
● dvpx-reflector.service - DVPX Reflector (Digi Voice Protocol eXtended)
     Loaded: loaded (/etc/systemd/system/dvpx-reflector.service; enabled)
     Active: active (running) since Mon 2026-08-03 14:22:01 UTC; 8s ago
   Main PID: 12847 (node)
```

Press `q` to exit.

If you see `failed` instead of `active (running)`, look at the log:

```bash
journalctl -u dvpx-reflector -n 50 --no-pager
```

---

## 11. Step 9 — Verify that it works

Four checks; if they all pass, the installation is complete.

### Check 1 — Is the log clean?

```bash
journalctl -u dvpx-reflector -n 30 --no-pager
```

You should see the `DVPX reflector is ready. 73!` line and the
`politika guncellendi` line. You should **not** see the words `KILITLENDI`,
`basarisiz` or `UYUSMAZLIGI`.

### Check 1b — Was the link with the other reflectors established?

```bash
journalctl -u dvpx-reflector -n 200 --no-pager | grep -i "bag"
```

Expected lines:

```
[peer] bag eklendi: DVPX-DE#3 (203.0.113.9:62071)
[peer] bag AYAKTA: DVPX-DE#3 (203.0.113.9:62071)
```

If you saw `bag AYAKTA` (link UP), talkgroups are shared with that reflector:
users on the same TG hear each other on both servers.

If you see `bag DUSTU` (link DOWN), the other side is not answering. Check in
order: is the other reflector running, is it approved in the dashboard, is UDP
62071 open on the other side.

If there is no `bag` line at all: the dashboard did not give you a peer list.
Look at the **Link** column on the **Reflectors** page in the dashboard; the
reason is written there (not approved / no token / silent for a long time).

### Check 2 — Are the ports really being listened on?

```bash
ss -tulpn | grep -E "62070|62071"
```

**What you should see** (two lines — one tcp, one udp):

```
tcp   LISTEN 0  511   0.0.0.0:62070   0.0.0.0:*   users:(("node",pid=12847,fd=20))
udp   UNCONN 0  0     0.0.0.0:62071   0.0.0.0:*   users:(("node",pid=12847,fd=18))
```

### Check 3 — Is it reachable from outside?

This is the most important check and it is done **from your own computer**, not
from the server. Open a new PowerShell/Terminal window:

```bash
nc -vz dvpx.example.com 62070
```

(Replace `dvpx.example.com` with your own address.)

**What you should see:**

```
Connection to dvpx.example.com port 62070 [tcp] succeeded!
```

If the `nc` command does not exist on Windows, use this in PowerShell:

```powershell
Test-NetConnection dvpx.example.com -Port 62070
```

You should see `TcpTestSucceeded : True`.

**If it failed**, the problem is almost certainly the firewall — go back to
Step 6, especially the "firewall in your provider's panel" part.

> Testing UDP this way is not reliable (UDP does not answer). If TCP passed and
> you added the UDP rule in the same way, it is most likely fine; the definitive
> proof is talking through an application.

### Check 4 — Does it appear in the dashboard?

Ask the administrator, or check yourself: on the dashboard's **Reflectors** page
your row should have:

- a green label reading **APPROVED**,
- a green "Last Seen" value in the form **● moments ago**,
- a **▲** mark next to the name (= published to the applications).

Final test: choose the DVPX protocol in a Digi Voice application; your reflector
should appear in the server list. When you connect and pick a TG, your
transmission appears instantly on the dashboard's **Last Heard** page.

---

## 12. Troubleshooting

### Solution table by error message

The reflector tries to write its errors understandably. Find your message here:

| What you see in the log | What it means | Solution |
|---|---|---|
| `dashboard.url ve dashboard.token ZORUNLUDUR` | `config.json` is missing or was not found | Repeat Step 5. Make sure the file is inside `dvpx-reflector/` and is named exactly `config.json` |
| `config.json ESKI SURUME ait` | The file contains an old `database` block | Delete the `database` block and write a `dashboard` block instead |
| `gecerli JSON degil` | Typo | Look for an extra comma / a missing quote. Paste the text the dashboard gave you again |
| `Bu token taninmiyor` | The token is wrong or has been revoked | Ask the administrator for a new token. Make sure you did not copy a leading/trailing space |
| `REFLEKTOR ONAY BEKLIYOR` | The token is right, but the administrator has not approved it | Let the administrator know. The moment they approve it, it goes into service **by itself**; you do not have to do anything |
| `panele ulasilamadi ... onbellekte politika yok` | Internet/address problem | See the "Cannot reach the dashboard" section below |
| `panelden beklenmeyen yanit ... HTTP 404` | Wrong address | `dashboard.url` must end with `/reflector.php` |
| `panel HTML dondurdu` | The address points at the dashboard's home page | Same: make sure the address ends with `reflector.php` |
| `PORT UYUSMAZLIGI` | The port recorded in the dashboard differs from the port you listen on | Correct either the port in `config.json` or the port recorded in the dashboard — the two must be the same |
| `cannot bind TCP ... EADDRINUSE` | The port is used by another program | Find it with `ss -tulpn \| grep 62070`. Usually a second copy of the reflector is running: `systemctl stop dvpx-reflector` |
| `cannot bind TCP ... EACCES` | A port lower than 1024 was chosen | Use a port above 1024 (the defaults 62070/62071 are fine) |
| `panelde "offline" durumunda` | The administrator turned publishing off | The reflector is running but is not published to the applications. Ask the administrator |
| `KILITLENDI` | The dashboard rejected the token | Ask the administrator for a new token |

### Cannot reach the dashboard

Test in order. These commands are run **on the server**:

**1. Is there internet?**

```bash
ping -c 3 1.1.1.1
```

**2. Does the domain name resolve?**

```bash
ping -c 3 digivoice.algsoft.net.tr
```

If it says `Name or service not known` there is a DNS problem.

**3. Is the dashboard's API answering?** (The most useful test.)

```bash
curl -sS "https://dvpx.algsoft.net.tr/reflector.php?action=ping"
```

**What you should see:**

```json
{"ok":true,"protocol":"DVPX","endpoint":"reflector-control","api":1,...}
```

- **If you see this**, the address is correct; the problem is with the token or
  the approval.
- **Empty output / connection error** → your server's outbound access may be
  blocked. This is rare, but some providers restrict outgoing connections.
- **HTML output** → the address is wrong. Ask the administrator for the exact
  address shown on the dashboard's Reflectors page.
- **An error containing `certificate`** → the dashboard's SSL certificate is
  invalid. The administrator has to fix it.

**4. Test the token directly:**

```bash
curl -sS -H "X-DVPX-Token: YOUR_TOKEN_HERE" \
     "https://dvpx.algsoft.net.tr/reflector.php?action=snapshot"
```

If a JSON containing your TG list comes back, the token is valid.

### Users cannot connect but the log is clean

Almost always the firewall. In order:

1. `ufw status` → do 62070/tcp and 62071/udp appear?
2. The firewall in the provider's web panel → are the same rules there?
3. From your own computer, `nc -vz ADDRESS 62070` → does it succeed?
4. Is the address/port recorded in the dashboard really your server? (A single
   wrong character is enough.)

### No audio / the other side cannot hear

If signalling (TCP) works but audio (UDP) does not, **the UDP port is closed.**
Skipping UDP while adding the TCP rule is very common:

```bash
ufw allow 62071/udp
```

and do the same in the provider's panel. Watch this in the log:

```bash
journalctl -u dvpx-reflector -f | grep stats
```

`rx 0` (no packets arriving at all) → the UDP port is closed.
`rx` is increasing but `fwd 0` → packets arrive but are not forwarded: the users
may not be subscribed to the same TG.

### What happens if the dashboard goes down / the internet drops?

**The reflector keeps working.** Audio flows, users can log in; the reflector
uses the last policy it holds (TG list, blocked users). Reports wait in the
queue and are sent when the connection returns — call records are not lost.

You will see this in the log:

```
[contr] panel erisilemiyor; ses yonlendirme ve girisler ONBELLEKTEKI politika ile SURUYOR.
```

When the connection returns:

```
[contr] panel baglantisi geri geldi / dashboard reachable again
```

The only exception: the dashboard **explicitly** rejecting the token
(revocation/removal of approval). In that case the reflector locks itself — this
is deliberate behaviour, it is the way of removing a reflector from the network.

---

## 13. Daily use: command card

```bash
# Version (no config needed; prints only the number)
node /opt/dvpx-reflector/src/index.js -v

# Status
systemctl status dvpx-reflector

# Follow the log live (exit with Ctrl+C)
journalctl -u dvpx-reflector -f

# Last 100 lines
journalctl -u dvpx-reflector -n 100 --no-pager

# Show errors only
journalctl -u dvpx-reflector -p err --no-pager

# Restart (REQUIRED after changing config.json)
systemctl restart dvpx-reflector

# Stop / start
systemctl stop dvpx-reflector
systemctl start dvpx-reflector

# Disable automatic start at server boot
systemctl disable dvpx-reflector

# Ports being listened on
ss -tulpn | grep -E "62070|62071"

# How many users are connected? (the statistics line is written once a minute)
journalctl -u dvpx-reflector -n 200 --no-pager | grep stats | tail -3
```

**Do not forget to restart after every change to `config.json`.** The reflector
reads the file only at startup.

---

## 14. Updating

Apply this section when a new DVPX version is released, or when the dashboard
administrator sends you an **update order** (you will see it as a red warning on
your panel). The operation takes 2–3 minutes and your reflector drops off the
network during that time.

### Back up first

`config.json` is your own file; updates do not touch it (because it is not kept
in the repository, `git pull` does not overwrite it either). Still, a backup
costs you a minute and saves you from having to ask for the token again:

```bash
cp /opt/dvpx-reflector/config.json ~/config.json.backup
```

### Way A — If you installed with Git (recommended)

If Git is not installed:

```bash
sudo apt install -y git
```

Then five commands:

```bash
sudo systemctl stop dvpx-reflector
cd /opt/dvpx-reflector
sudo git pull
sudo chown -R dvpx:dvpx /opt/dvpx-reflector
sudo systemctl start dvpx-reflector
```

> Run the `git pull` command **inside `/opt/dvpx-reflector`**. In any other
> directory you get a `not a git repository` error.

**If you never installed with Git** (the directory is not a repository) you can
re-clone it once — your `config.json` is preserved:

```bash
sudo systemctl stop dvpx-reflector
sudo mv /opt/dvpx-reflector /opt/dvpx-reflector.old
sudo git clone https://github.com/cektor/DVPX.git /opt/dvpx-reflector
sudo cp /opt/dvpx-reflector.old/config.json /opt/dvpx-reflector/
sudo chown -R dvpx:dvpx /opt/dvpx-reflector
sudo chmod 600 /opt/dvpx-reflector/config.json
sudo systemctl start dvpx-reflector
```

Once you have seen that everything works you can delete the old folder:
`sudo rm -rf /opt/dvpx-reflector.old`

### Way B — If you installed manually

Copy the new files to the same place:

```bash
sudo systemctl stop dvpx-reflector
# unpack the new zip and copy its contents over /opt/dvpx-reflector
sudo chown -R dvpx:dvpx /opt/dvpx-reflector
sudo systemctl start dvpx-reflector
```

> ⚠️ **CAUTION:** make sure your `config.json` is NOT overwritten. If it was,
> restore it from the backup: `sudo cp ~/config.json.backup
> /opt/dvpx-reflector/config.json`

### Verify that it was updated

```bash
node /opt/dvpx-reflector/src/index.js -v
systemctl status dvpx-reflector
journalctl -u dvpx-reflector -n 30 --no-pager
```

The first command should print the new version number, the service should be
`active (running)`, and the `DVPX reflector is ready. 73!` line should appear in
the log.

If the dashboard administrator sent you an update order: the moment the reflector
reports the new version to the dashboard (a few minutes at most) the **red
warning on your panel clears itself.** You do not have to press a button or
notify the administrator. If the warning stays, the update did not actually take
effect — check the `-v` output above.

> **If you don't want to do all of this by hand every time**, see §17: by
> installing an optional helper service, your reflector can update **itself**
> (no SSH needed at all) the moment the dashboard administrator places an
> update order.

---

## 15. Frequently asked questions

**Do I have to install the dashboard?**
No. The dashboard runs at the centre of the network, in a single place, and is
operated by the network administrator. You are only installing a reflector.

**Do I have to install a database?**
No. The reflector has no relationship with a database whatsoever. Do not install
MySQL.

**Should I run `npm install`?**
No. The reflector has no external dependencies. Node.js 18+ alone is enough.

**Can I create talkgroups? Can I block users?**
No, those are done in the dashboard and belong to the network administrator.
Your reflector enforces the dashboard's decisions. If you want a new TG you tell
the administrator; the moment they create it (within a few seconds) it becomes
active on your reflector too — no restart needed.

**Can I run two reflectors on the same server?**
Technically yes: each one needs a separate directory, a separate `config.json`,
a separate token and **different ports** (e.g. 62070/62071 and 62080/62081).
But there is little point — one reflector carries hundreds of users.

**I lost the token.**
You have to ask the administrator for a new one; the token is not stored in the
dashboard (only its encrypted digest is kept), so nobody can bring the old one
back. The moment a new token is generated the old one becomes invalid.

**I want to shut my reflector down.**
```bash
systemctl stop dvpx-reflector
systemctl disable dvpx-reflector
```
Let the administrator know as well, so they can delete your record from the
dashboard. When you shut it down the dashboard considers you "stale" within 2
minutes and automatically stops offering you to users — nobody tries to connect
to a dead address.

**My server's IP changed.**
Tell the administrator; they have to update the address in the dashboard. No new
token is needed.

**Will the logs fill up the disk?**
Logs go to systemd's journal and are rotated automatically. If you want to
reduce the limit:
```bash
journalctl --vacuum-size=200M
```

**How many users can it carry?**
The default of `maxSessions` is 500. Voice traffic is roughly 20 kbit/s per
user; 100 simultaneous listeners ≈ 2 Mbit/s. The bottleneck is almost always
bandwidth, not CPU.

---

## 16. Reflector-to-reflector link (shared talkgroups)

### What does it do?

In DVPX a talkgroup (TG) **does not belong to a single reflector.** While you
are on TG 286 on your own reflector, if a friend on another reflector is also on
TG 286 then **you hear each other and can talk.** Private calls are
network-wide too: the call rings on whichever reflector the person you are
calling is registered on.

### What do you have to do?

**Nothing.** The link is established by itself. The only condition is that both
reflectors are:

1. **approved in the dashboard** (Reflectors → ✓ button),
2. in possession of a **token** (generated with ⚿),
3. have **reported to the dashboard** within the last 10 minutes (i.e. are
   running).

The dashboard gives every reflector that meets these three conditions the list
of the others and a **shared key** for each pair. You do **not** need to share
the keys by hand, write them into a file or send them to your friend — they are
not even visible in the dashboard.

When a new reflector is approved the link is established **within seconds**; you
do not need to restart the service.

### Security

- **Every single** peer frame is signed with HMAC-SHA256. No audio whose
  signature does not verify is accepted; someone who knows your UDP port
  **cannot** inject audio into your TGs.
- Audio arriving from a peer **is not forwarded to another peer**. This rule
  makes an audio loop impossible even if all reflectors are connected to each
  other.
- There is a ±30-second timestamp window against replaying recorded traffic.
  Keep **NTP enabled** on your server (check with `timedatectl`); clock drift
  prevents the link from being established.
- The keys are stored in the `policy.cache.json` file and that file is written
  with `0600` permissions (only the user running the reflector can read it).

### Fine tuning (not required, but possible)
NOTE: The settings here must remain as configured on your server and should not be changed.
There must be no issues. Otherwise, your reflector will be deleted from the system and your TG channels will be closed.

You can add a `peers` block to `config.json`:

```json
"peers": {
  "enabled": true,
  "bridgeTalkgroups": "all",
  "bridgePrivateTalkgroups": true,
  "bridgePrivateCalls": true,
  "packetsPerSecond": 5000
}
```

| Setting | Meaning |
|---|---|
| `enabled: false` | Turns the link off completely — your reflector works alone, the same TG on the others is not heard. |
| `bridgeTalkgroups: [9, 286]` | Only these TGs are bridged; the rest stay local. |
| `bridgePrivateTalkgroups: false` | Private TGs are not bridged. |
| `bridgePrivateCalls: false` | Private calls are not forwarded to the other reflectors. |

The environment variable `DVPX_PEERS=0` also turns the link off (for a quick
test).

### Bandwidth

A transmission produces a packet of about 66 bytes every 20 ms (≈26 kbit/s). A
peer frame adds a 32-byte header → **≈40 kbit/s per active transmission per
peer**. In a network of three reflectors the outgoing traffic for a single
speaker is ≈80 kbit/s; negligible for an ordinary VPS.

---

## 17. Automatic updates — no SSH (optional)

### What does this do?

Normally, when an update order arrives (§14) you have to log in over SSH and
run a few commands. If you install the **optional** helper service in this
section, the moment the dashboard administrator places an update order your
reflector will, **by itself**, within a few minutes: pull the new version,
safely stop and restart the service, and report the result back to the
dashboard. You do nothing; you never have to open an SSH session.

### What exactly are you granting?

Installing this gives the dashboard administrator the ability to do
**exactly this** on your server — **nothing else**:

```
git fetch + git reset --hard   (only from the repo/branch YOU set)
systemctl stop/start dvpx-reflector
```

- The dashboard **never** sends you an address, branch name, or command —
  it only ever says "there is/isn't a pending order". Where to pull from,
  and which branch, are **always** read from the `updater.json` file on
  this server (you write it, below). Even if the dashboard were fully
  compromised, the worst case is an "unnecessary update" being triggered;
  code can never be pulled from some other server.
- Your `config.json` and `policy.cache.json` files are **never** touched
  (see Step 3 — they are not tracked in the repository).
- This capability belongs to a small helper service (`dvpx-updater`) that
  runs **completely separately from the main reflector process**, on its
  own, as root. The actual `dvpx-reflector` service that handles voice and
  signalling coming in from the internet keeps running as an unprivileged
  user — a bug there can never escalate into this new capability.
- **If you don't install it, nothing changes.** Your reflector keeps being
  updated by hand (§14), exactly as today.
- **You can withdraw it at any time, with a single command** — see Step 5.

### First — are these files already on your server?

`tools/dvpx-updater.sh`, `dvpx-updater.service`, `dvpx-updater.timer`, and
`updater.json.example` arrive on the reflector through the **normal update
procedure in §14** — an older installation, set up before this feature was
released, may not have them yet. Check:

```bash
ls /opt/dvpx-reflector/tools/dvpx-updater.sh
```

**If it says "No such file or directory"**, update your reflector first:

- **If you installed with Git** (`/opt/dvpx-reflector/.git` exists):
  ```bash
  cd /opt/dvpx-reflector
  sudo git pull
  ```
  This does NOT require stopping the main `dvpx-reflector` service — as
  long as the service's own code (`src/`) hasn't changed, files are simply
  added and the running service is unaffected. If you are unsure, apply
  the full §14 procedure anyway (stop → pull → start); it does no harm.
- **If you installed manually**, ask the network administrator or get
  these four files from `https://github.com/cektor/DVPX` and copy them by
  hand into the matching relative paths (`tools/` and the reflector's root
  directory), then:
  ```bash
  sudo chmod +x /opt/dvpx-reflector/tools/dvpx-updater.sh
  ```

If the files are already there, skip straight to Step 1.

### Step 1 — Ask the administrator for an "updater token"

This is a **second key, separate** from the API token in your config.json.
On the dashboard, from the **My Reflectors** page, press **🤖 Request
Auto-Update**, write a short justification, and once the administrator
approves it the token lands on your panel. (The administrator may also
generate and hand it to you without being asked.)

### Step 2 — Open it and create updater.json

On the dashboard, pressing **🤖 Show Updater Token** shows a ready-to-use
`updater.json`:

```json
{
  "dashboardUrl": "https://panel.example.com/dvpx/updater.php",
  "updaterToken": "dvpxupd_8f3a91c7e2b45d06a1f8...",
  "reflectorDir": "/opt/dvpx-reflector",
  "gitRemote": "https://github.com/cektor/DVPX.git",
  "gitBranch": "main"
}
```

Save it on the server:

```bash
sudo nano /opt/dvpx-reflector/updater.json
```

(Paste the content and save.) Then lock it down:

```bash
sudo chmod 600 /opt/dvpx-reflector/updater.json
```

> **If `/opt/dvpx-reflector` was not installed with Git** (Way B — manual
> install), don't worry: the helper service converts the directory to a
> Git checkout by itself on its first run; it does not touch your
> `config.json` or `policy.cache.json`.

### Step 3 — Install the services

```bash
sudo cp /opt/dvpx-reflector/dvpx-updater.service /etc/systemd/system/
sudo cp /opt/dvpx-reflector/dvpx-updater.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dvpx-updater.timer
```

If you installed to a different path, fix the `WorkingDirectory` and
`ExecStart` lines in `dvpx-updater.service`, just as you did for
`dvpx-reflector.service`.

### Step 4 — Verify

```bash
systemctl status dvpx-updater.timer
journalctl -u dvpx-updater -n 30 --no-pager
```

If there is no pending order you will see `bekleyen emir yok, cikiliyor`
("no pending order, exiting") in the log — this is normal and repeats
**every 5 minutes**. When the administrator places an order it is applied
on the next tick automatically; watch progress with the same command.

To try it once immediately by hand:

```bash
sudo /opt/dvpx-reflector/tools/dvpx-updater.sh
```

### Step 5 — If you change your mind

One command is enough, it's fully reversible and does no harm:

```bash
sudo systemctl disable --now dvpx-updater.timer
```

Your main reflector service is completely unaffected and keeps running. If
you like, also **revoke the updater token** on the dashboard (🤖✕ /
"Disable auto-update") — that closes the permission on the dashboard side
too.

### What happens if an update fails?

A few seconds after applying a new version, the helper service checks that
the service is actually still up. If it isn't, it **automatically rolls
back** to the previous version and starts that instead — your reflector
never gets stuck "half-updated" and off the network. The result (success or
rolled-back) shows up both in `journalctl -u dvpx-updater` and on the
dashboard (My Reflectors → underneath the version column).

---

## When asking for help

Send these three things together and the problem is usually obvious at first
glance:

```bash
# 1) The log (contains no token, you can share it safely)
journalctl -u dvpx-reflector -n 60 --no-pager

# 2) config.json — share it WITH THE TOKEN LINE DELETED!
cat /opt/dvpx-reflector/config.json

# 3) Ports
ss -tulpn | grep -E "62070|62071"
```

> ⚠️ When sharing the contents of `config.json`, **always delete or asterisk out
> the token line.** Anyone holding the token can join the network as if they
> were your reflector.

Good luck. 73!

−·· ···− ·−· −··−


Digi Voice Developer
Fatih ÖNDER TB1TFO
Telegram: @tb1tfo
info@fatihonder.org.tr
https://fatihonder.org.tr

Company: ALGSoft Inc.
info@algsoft.net.tr
https://algsoft.net.tr

QRV73.com Amateur Radio Platform
iletisim@qrv73.com
https://qrv73.com

QRZ73.org.tr Amateur Radio CallBook
info@qrz73.org.tr
