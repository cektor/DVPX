# DVPX Reflektör Kurulumu — Sıfırdan Anlatım

Bu kılavuz **hiç sunucu yönetmemiş biri için** yazıldı. Komutları sırayla
kopyalayıp yapıştırmanız yeterlidir. Her adımda "ne göreceğinizi" de yazdım;
gördüğünüz şey yazandan farklıysa doğrudan [Sorun Giderme](#12-sorun-giderme)
bölümüne bakın.

Tahmini süre: **20–30 dakika.**

---

## İçindekiler

1. [Reflektör nedir, neyi yapar?](#1-reflektör-nedir-neyi-yapar)
2. [Neye ihtiyacınız var?](#2-neye-ihtiyacınız-var)
3. [Adım 1 — Yöneticiden token isteyin](#3-adım-1--yöneticiden-token-isteyin)
4. [Adım 2 — Sunucuya bağlanın](#4-adım-2--sunucuya-bağlanın)
5. [Adım 3 — Node.js kurun](#5-adım-3--nodejs-kurun)
6. [Adım 4 — DVPX dosyalarını yerleştirin](#6-adım-4--dvpx-dosyalarını-yerleştirin)
7. [Adım 5 — config.json oluşturun](#7-adım-5--configjson-oluşturun)
8. [Adım 6 — Güvenlik duvarında portları açın](#8-adım-6--güvenlik-duvarında-portları-açın)
9. [Adım 7 — İlk çalıştırma (deneme)](#9-adım-7--ilk-çalıştırma-deneme)
10. [Adım 8 — Servis olarak kurun (sürekli çalışsın)](#10-adım-8--servis-olarak-kurun-sürekli-çalışsın)
11. [Adım 9 — Çalıştığını doğrulayın](#11-adım-9--çalıştığını-doğrulayın)
12. [Sorun Giderme](#12-sorun-giderme)
13. [Günlük kullanım: komut kartı](#13-günlük-kullanım-komut-kartı)
14. [Güncelleme](#14-güncelleme)
15. [Sık sorulanlar](#15-sık-sorulanlar)
16. [Reflektörler arası bağ (TG'ler ortak)](#16-reflektörler-arası-bağ-tgler-ortak)

---

## 1. Reflektör nedir, neyi yapar?

DVPX iki parçadan oluşur:

```
   ┌───────────────────────────────────────────────────┐
   │  DASHBOARD (PANEL)  —  ağın merkezi, TEK TANEDİR  │
   │                                                   │
   │  • kullanıcılar, engelleme                        │
   │  • talkgroup (TG) oluşturma / kapatma             │
   │  • özel TG yetkileri                              │
   │  • reflektörlerin onayı ve token'ları             │
   │  • veritabanı SADECE burada                       │
   └──────────────────┬────────────────────────────────┘
                      │  HTTPS + token
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐
   │REFLEKTÖR│  │REFLEKTÖR│  │REFLEKTÖR│   ← bu kılavuz bunu kuruyor
   │ (sunucu)│  │         │  │         │
   └────┬────┘  └─────────┘  └─────────┘
        │ TCP 62070 (sinyalleşme) + UDP 62071 (ses)
        ▼
   Digi Voice uygulamaları (telefon / bilgisayar)
```

**Reflektör yalnızca ses taşır.** Kimin konuşabileceğine, hangi TG'lerin açık
olduğuna panel karar verir; reflektör bu kararları panelden alır ve uygular.

Bunun sizin için anlamı:

| | |
|---|---|
| **Veritabanı bilgisi gerekmez** | Reflektör MySQL'e hiç bağlanmaz. Elinizde tek bir token olur. |
| **Panel kurmanız gerekmez** | Panel merkezde, ağ yöneticisindedir. |
| **`npm install` gerekmez** | Reflektörün hiçbir dış bağımlılığı yoktur. Sadece Node.js. |
| **Yönetim işi yoktur** | TG açma, kullanıcı engelleme gibi işler sizde değil, panelde. |

---

## 2. Neye ihtiyacınız var?

### a) Bir sunucu (VPS)

En düşük gereksinimler gerçekten düşüktür:

| | En az | Rahat |
|---|---|---|
| CPU | 1 çekirdek | 4 çekirdek |
| RAM | 1 GB | 4 GB |
| Disk | 5 GB | 30 GB |
| İşletim sistemi | Ubuntu 22.04 / Debian 12 | Ubuntu 24.04 |
| Node.js | 18 | 20 |

**SABİT (STATİK) GENEL IP ADRESİ ŞARTTIR.** Uygulamaların reflektöre
internetten doğrudan bağlanması gerekir; adres değişirse bağlı olan herkes
düşer. VPS sağlayıcıları sabit IP'yi varsayılan olarak verir.

> **VPS şart mı?** Hayır — belirleyici olan kutunun türü değil, karşıladığı
> gereksinimlerdir. **Raspberry Pi 4 / 5** ya da benzeri bir mini bilgisayar
> (Intel NUC, thin client, eski bir dizüstü) yukarıdaki eşiği karşıladığı ve
> 7/24 açık kalabildiği sürece kullanılabilir. Raspberry Pi kullanacaksanız
> 64-bit Raspberry Pi OS (Debian tabanlı) kurun; bu kılavuzdaki bütün komutlar
> olduğu gibi çalışır. Sistemi SD kart yerine SSD/USB diskten çalıştırmanız
> önerilir: SD kartlar sürekli yazma altında yıllar değil aylar dayanır ve
> habersiz ölürler.
>
> Ev interneti genelde uygun DEĞİLDİR (dinamik IP, NAT, kapalı portlar).
> Yine de evde denemek isterseniz modeminizde port yönlendirmesi yapmanız
> gerekir.

### b) Sabit bir adres (IP veya alan adı)

Ya IP'yi doğrudan kullanırsınız (`203.0.113.10`) ya da bir **alan adı**
yönlendirirsiniz (`dvpx.sizinsite.com`). **Alan adı daha iyidir:** sunucuyu bir
gün başka bir sağlayıcıya taşırsanız yalnızca DNS kaydını değiştirirsiniz,
kullanıcıların ayarına dokunmanız gerekmez.

### c) Panelden bir API token'ı

Bunu **ağ yöneticisi** üretip size verir. Bir sonraki adım bu.

### d) Sunucuya bağlanma bilgisi

Sağlayıcınız size şunları verir: **IP adresi**, **kullanıcı adı** (genelde
`root`), **şifre** veya **SSH anahtarı**.

---

## 3. Adım 1 — Yöneticiden token isteyin

Ağ yöneticisine şu bilgileri gönderin:

```
Reflektör kurmak istiyorum. Bilgiler:

  Sunucu adı  : DVPX-ANKARA          (istediğiniz ad)
  Adres       : dvpx.ornek.com       (IP veya alan adı)
  TCP portu   : 62070                (port 62070 olmak zorunda)
  UDP portu   : 62071                (port 62071 olmak zorunda)
  Bölge       : TR
  Çağrı işaretim / iletişim: TA1XYZ · eposta@ornek.com
```

Yönetici panelde şunları yapar: **Reflektörler → Yeni Reflektör** ile kaydınızı
açar, ardından satırınızdaki **⚿** düğmesine basar. Panel ona size
gönderilecek, doğrudan kullanıma hazır bir metin gösterir:

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

**Bu metni saklayın.** Token panelde **yalnızca bir kez** gösterilir; kaybolursa
yönetici yenisini üretmek zorunda kalır (ve eskisi anında geçersizleşir).

> ⚠️ **Token bir şifredir.** WhatsApp/e-posta ile gönderilmesi kaçınılmazsa,
> ileten kişi mesajı sonradan silsin. Token'a sahip olan kişi ağa reflektör
> olarak katılabilir.

---

## 4. Adım 2 — Sunucuya bağlanın

### Windows kullanıyorsanız

Windows 10/11'de PowerShell yeterlidir. **Başlat → PowerShell** yazıp açın:

```powershell
ssh root@203.0.113.10
```

(`203.0.113.10` yerine kendi sunucu IP'nizi yazın.)

İlk bağlantıda şunu sorar — `yes` yazıp Enter'a basın:

```
The authenticity of host '203.0.113.10' can't be established.
Are you sure you want to continue connecting (yes/no)? yes
```

Sonra şifrenizi ister. **Şifreyi yazarken ekranda hiçbir şey görünmez** — bu
normaldir, yazıp Enter'a basın.

### Mac veya Linux kullanıyorsanız

Terminal'i açıp aynı komutu yazın:

```bash
ssh root@203.0.113.10
```

### Bağlandığınızı nasıl anlarsınız?

Satır başı şuna benzer bir şeye dönüşür:

```
root@vps-12345:~#
```

Artık yazdığınız komutlar **sunucuda** çalışıyor. Bundan sonraki tüm komutlar
bu ekranda yazılacak.

### İlk iş: sistemi güncelleyin

```bash
apt update && apt upgrade -y
```

Bu birkaç dakika sürebilir. Bir ara "hangi servisler yeniden başlatılsın?"
diye renkli bir ekran çıkarsa Tab tuşuyla `<Ok>`'e gelip Enter'a basın.

---

## 5. Adım 3 — Node.js kurun

Reflektör Node.js ile çalışır. **Sürüm 18 veya üzeri** gerekir.

Önce zaten kurulu mu diye bakın:

```bash
node --version
```

- `v18.19.0` gibi bir şey yazıyorsa (sayı 18'den büyük veya eşitse) → bu adımı
  **atlayın**, Adım 4'e geçin.
- `command not found` yazıyorsa veya sürüm 18'den küçükse → devam edin.

### Kurulum (Ubuntu / Debian)

Aşağıdaki iki komutu **sırayla** çalıştırın:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
```

```bash
sudo apt install -y nodejs
```

### Doğrulayın

```bash
node --version
```

**Görmeniz gereken:** `v20.` ile başlayan bir sürüm numarası. Örnek:

```
v20.18.1
```

> **Not:** `npm install` çalıştırmanıza **gerek yok**. DVPX reflektörünün hiçbir
> dış paket bağımlılığı yoktur; Node'un kendi içindeki modülleri kullanır.

### Git'i de şimdi kurun

Bir sonraki adımda dosyaları depodan çekeceğiz; `git` çoğu sunucuda kurulu
gelmez:

```bash
sudo apt install -y git
```

Doğrulayın:

```bash
git --version
```

`git version 2.x.x` gibi bir çıktı görmelisiniz.

---

## 6. Adım 4 — DVPX dosyalarını yerleştirin

İşimiz bittiğinde dizin yapısı şöyle olacak:

```
/opt/dvpx-reflector/            ← BURADA çalışacağız
├── src/                        ← program dosyaları
├── tools/                      ← test istemcisi
├── package.json
├── config.example.json         ← örnek; kopyalamanız gerekmez
├── config.json                 ← BUNU siz oluşturacaksınız (Adım 5)
├── dvpx-reflector.service
├── KURULUM.md                  ← bu dosya
└── install.md                  ← aynı kılavuzun İngilizcesi
```

Yani bu kılavuzdaki **çalışma dizini** hep şudur:

```
/opt/dvpx-reflector
```

> **Depoda panel (dashboard) YOKTUR** — yayınlanan depo yalnızca reflektördür ve
> dosyalar doğrudan kökünde durur. Panel ağın merkezinde, ağ yöneticisinde
> çalışır; sizin sunucunuza kurulmaz.

> **Neden tam olarak bu yol?** Depoyla birlikte gelen
> `dvpx-reflector.service` dosyası bu yolu kullanır. Bu yola kurarsanız servis
> dosyasını **hiç düzenlemeden** kopyalayabilirsiniz; başka bir yere kurarsanız
> üç satırını elle değiştirmeniz gerekir (Adım 8'de anlatılıyor).

Şimdi DVPX dosyalarını buraya alacağız. **İki yol var**, birini seçin.
Git ile kurmanız **önerilir**: güncelleme tek komuta iner (Bölüm 14).

### Yol A — Git ile (önerilen)

Git kurulu değilse önce onu kurun:

```bash
sudo apt install -y git
```

Sonra depoyu doğrudan `/opt/dvpx-reflector` içine klonlayın:

```bash
sudo git clone https://github.com/cektor/DVPX.git /opt/dvpx-reflector
```

Klonlama bittiğinde çalışma dizinine geçin:

```bash
cd /opt/dvpx-reflector
```

> **Komutun sonundaki yolu atlamayın.** `git clone <adres>` biçiminde
> yazarsanız git, bulunduğunuz dizinin içine `DVPX` adlı bir klasör açar ve
> dosyalar `/opt/dvpx-reflector` yerine başka bir yere düşer. Hedef dizini
> açıkça vermek, dosyaların tam olarak istediğimiz yere gelmesini sağlar —
> `mkdir` yapmanız da gerekmez, git dizini kendisi oluşturur.

### Yol B — Elle yükleme (dosyaları size zip olarak verdiyse)

Kendi bilgisayarınızda, **yeni bir PowerShell/Terminal penceresi** açın (SSH
penceresini kapatmayın) ve zip dosyasının bulunduğu dizinde:

```bash
scp DVPX.zip root@203.0.113.10:/opt/
```

Sonra SSH penceresine dönüp:

```bash
sudo apt install -y unzip
cd /tmp
sudo unzip /opt/DVPX.zip
ls
```

`ls` çıktısında açılan klasörün adını göreceksiniz (`DVPX`, `DVPX-main` gibi).
O adı aşağıdaki komutta kullanın:

```bash
sudo mkdir -p /opt/dvpx-reflector
sudo cp -r /tmp/DVPX/. /opt/dvpx-reflector/
sudo rm -rf /tmp/DVPX /opt/DVPX.zip
cd /opt/dvpx-reflector
```

> Sondaki `/.` önemlidir: klasörün **içindekileri** kopyalar. Onu yazmazsanız
> dosyalar `/opt/dvpx-reflector/DVPX/` altına iner ve sonraki adımlardaki
> yolların hiçbiri çalışmaz.

> Elle kurulumda güncelleme de elle yapılır. Git ile kurduysanız güncelleme
> `git pull` ile tek komuttur; bu yüzden Yol A önerilir.

### Doğrulayın

```bash
ls /opt/dvpx-reflector/src/
```

**Görmeniz gereken:**

```
config.js  control.js  index.js  logger.js  packet.js  peers.js  sessions.js  tcp-server.js  udp-server.js
```

Bu dosyaları görmüyorsanız yol farklı olabilir. Şununla arayın:

```bash
find / -name "control.js" -path "*reflector*" 2>/dev/null
```

Çıkan yolu not edin; sonraki adımlarda `/opt/dvpx-reflector` yerine
onu kullanacaksınız.

---

## 7. Adım 5 — config.json oluşturun

Reflektör dizinine geçin:

```bash
cd /opt/dvpx-reflector
```

Dosyayı `nano` düzenleyicisiyle oluşturun:

```bash
nano config.json
```

Boş bir ekran açılır. **Yöneticinin size verdiği metni** buraya yapıştırın.

- **Windows PowerShell'de yapıştırma:** farenin **sağ tuşu**.
- **Mac Terminal'de:** `Cmd + V`.

Yapıştırdıktan sonra dosya şuna benzemeli:

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

**Kaydetmek için:**

1. `Ctrl + O` (harf O, sıfır değil) → Enter (dosya adını sorar, onaylayın)
2. `Ctrl + X` (çıkış)

### Dosyayı gizleyin

Token bir şifredir; başka kullanıcılar okumasın:

```bash
chmod 600 config.json
```

### Doğrulayın

```bash
cat config.json
```

Yazdığınız içerik görünmeli. JSON'da sık yapılan hatalar:

| Hata | Doğrusu |
|---|---|
| Son satırdan sonra fazladan virgül | `"token": "..."` — virgül **yok** |
| Tırnak eksik | Her metin `"` ile başlar ve biter |
| Akıllı tırnak (`"` `"`) | Düz tırnak `"` olmalı (kopyala-yapıştırda olabilir) |

### Ayarların anlamı

| Ayar | Ne işe yarar | Değiştirmeli miyim? |
|---|---|---|
| `serverName` | Log'larda görünen ad. Panel kendi adını bildirirse o kullanılır. | Hayır |
| `bindAddress` | `0.0.0.0` = tüm ağ arayüzlerini dinle | Hayır |
| `tcpPort` | Sinyalleşme portu (giriş, TG seçimi) | Panelle **aynı** olmalı |
| `udpPort` | Ses portu | Panelle **aynı** olmalı |
| `dashboard.url` | Panelin adresi | Yöneticinin verdiği gibi |
| `dashboard.token` | Kimlik anahtarınız | Yöneticinin verdiği gibi |

İsteğe bağlı ek ayarlar (yazmasanız da varsayılanlar kullanılır):

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

`maxSessions` sunucunuzun kapasitesine göre sizin kararınızdır: 512 MB RAM'li
bir VPS için 500 rahat bir üst sınırdır. Sorun ararken `logLevel` değerini
geçici olarak `"debug"` yapabilirsiniz.

---

## 8. Adım 6 — Güvenlik duvarında portları açın

Bu adımı **atlarsanız reflektör çalışır ama kimse bağlanamaz.** En sık yapılan
hata budur.

Açılması gereken portlar:

| Port | Protokol | Ne için |
|---|---|---|
| 62070 | **TCP** | Sinyalleşme (giriş, TG seçimi) |
| 62071 | **UDP** | Ses — **reflektörler arası bağ da bu portu kullanır** |
| 22 | TCP | SSH — kendi bağlantınız, kapatmayın! |

> 🔗 **Reflektörler arası bağ için ek port AÇMANIZ GEREKMEZ.** Diğer
> reflektörlerle ses alışverişi aynı UDP 62071 portundan yapılır. Yalnızca bu
> portun **hem gelen hem giden** yönde açık olduğundan emin olun — `ufw` ile
> giden trafik varsayılan olarak zaten açıktır.

### Ubuntu / Debian (ufw)

```bash
ufw allow 22/tcp
ufw allow 62070/tcp
ufw allow 62071/udp
ufw --force enable
```

> ⚠️ `ufw enable` komutundan **önce** mutlaka `ufw allow 22/tcp` çalıştırın.
> Yoksa kendi SSH bağlantınız kesilir ve sunucuya giremezsiniz.

Doğrulayın:

```bash
ufw status
```

**Görmeniz gereken:**

```
Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
62070/tcp                  ALLOW       Anywhere
62071/udp                  ALLOW       Anywhere
```

### Sağlayıcınızın panelindeki güvenlik duvarı

Bu ayrı bir katmandır ve **çoğu kişinin atladığı yer burasıdır.** Hetzner,
AWS, Oracle Cloud, Azure, Google Cloud gibi sağlayıcılarda sunucunun önünde
ikinci bir güvenlik duvarı vardır.

Sağlayıcınızın web panelinde şunu arayın: *Firewall*, *Security Group*,
*Network Rules*. Oraya da aynı kuralları ekleyin:

- Gelen (inbound) **TCP 62070** → izin ver
- Gelen (inbound) **UDP 62071** → izin ver

**Oracle Cloud kullanıyorsanız** ek olarak sunucunun içindeki iptables
kurallarını da düzeltmek gerekir (Oracle imajları varsayılan olarak her şeyi
kapatır):

```bash
iptables -I INPUT -p tcp --dport 62070 -j ACCEPT
iptables -I INPUT -p udp --dport 62071 -j ACCEPT
apt install -y iptables-persistent
netfilter-persistent save
```

---

## 9. Adım 7 — İlk çalıştırma (deneme)

Servis olarak kurmadan önce elle çalıştırıp her şeyin yolunda olduğunu
görelim.

```bash
cd /opt/dvpx-reflector
node src/index.js
```

> **Sürümü öğrenmek** için reflektörü çalıştırmaya gerek yok; bu komut
> `config.json` okumadan yalnızca sürüm numarasını yazar (betiklerden
> `$(node src/index.js -v)` ile alınabilir):
>
> ```bash
> node src/index.js -v          # ->  1.0.2
> node src/index.js -h          # kisa yardim
> ```

### Başarılı çıktı böyle görünür

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

Aradığınız üç satır:

1. `politika guncellendi: N TG` → **panel bağlantısı çalışıyor.**
2. `voice listening` ve `signalling listening` → **portlar açıldı.**
3. `uygulamalara dagitiliyor` → **kullanıcılar sizi listede görecek.**

Sorun varsa çıktı yerine bir hata görürsünüz — [Sorun Giderme](#12-sorun-giderme)
bölümündeki tabloda mesajı arayın.

### Denemeyi durdurun

`Ctrl + C` tuşlarına basın. Şunu görürsünüz:

```
[main ] SIGINT received, shutting down...
[contr] kapanis bildirimi gonderildi / final report sent
[main ] bye. 73!
```

> Bu aşamada reflektör **kapandı**. `Ctrl + C` ile çalıştırdığınız program SSH
> penceresini kapattığınızda da durur. Sürekli çalışması için bir sonraki adım
> gerekir.

---

## 10. Adım 8 — Servis olarak kurun (sürekli çalışsın)

Şimdi reflektörü sistem servisi yapacağız. Böylece:

- SSH penceresini kapatsanız da çalışır,
- sunucu yeniden başlarsa kendiliğinden açılır,
- çökerse 5 saniye içinde kendiliğinden yeniden başlar.

### 1) Ayrıcalıksız bir kullanıcı oluşturun

Reflektörü `root` ile çalıştırmayın. Bir güvenlik açığı çıkarsa etkisi sınırlı
kalsın:

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin dvpx
```

> "user 'dvpx' already exists" derse sorun yok, zaten var.

### 2) Dosya izinlerini ayarlayın

```bash
chown -R dvpx:dvpx /opt/dvpx-reflector
chmod 600 /opt/dvpx-reflector/config.json
```

### 3) Servis dosyasını yerleştirin

Hazır dosya depoda var:

```bash
sudo cp /opt/dvpx-reflector/dvpx-reflector.service /etc/systemd/system/
```

Adım 4'teki yolu (`/opt/dvpx-reflector`) kullandıysanız **bu dosyada
değiştirecek hiçbir şey yok** — servis dosyası zaten o yolu kullanıyor.

**Başka bir yere kurduysanız** dosyayı düzenlemeniz gerekir:

```bash
sudo nano /etc/systemd/system/dvpx-reflector.service
```

Şu üç satırdaki yolu kendi yolunuzla değiştirin, sonra `Ctrl+O`, Enter,
`Ctrl+X`:

```
WorkingDirectory=/opt/dvpx-reflector
Documentation=file:/opt/dvpx-reflector/KURULUM.md
ReadWritePaths=/opt/dvpx-reflector
```

Ayrıca `node` başka bir yerdeyse `ExecStart` satırını düzeltin. Node'un yerini
şöyle bulursunuz:

```bash
which node
```

### 4) Servisi başlatın

```bash
systemctl daemon-reload
systemctl enable dvpx-reflector
systemctl start dvpx-reflector
```

### 5) Durumunu kontrol edin

```bash
systemctl status dvpx-reflector
```

**Görmeniz gereken** — yeşil `active (running)`:

```
● dvpx-reflector.service - DVPX Reflector (Digi Voice Protocol eXtended)
     Loaded: loaded (/etc/systemd/system/dvpx-reflector.service; enabled)
     Active: active (running) since Mon 2026-08-03 14:22:01 UTC; 8s ago
   Main PID: 12847 (node)
```

Çıkmak için `q` tuşuna basın.

`active (running)` yerine `failed` görüyorsanız log'a bakın:

```bash
journalctl -u dvpx-reflector -n 50 --no-pager
```

---

## 11. Adım 9 — Çalıştığını doğrulayın

Dört kontrol; hepsi geçerse kurulum tamam.

### Kontrol 1 — Log temiz mi?

```bash
journalctl -u dvpx-reflector -n 30 --no-pager
```

`DVPX reflector is ready. 73!` satırını ve `politika guncellendi` satırını
görmelisiniz. `KILITLENDI`, `basarisiz` ya da `UYUSMAZLIGI` kelimelerini
**görmemelisiniz**.

### Kontrol 1b — Diğer reflektörlerle bağ kuruldu mu?

```bash
journalctl -u dvpx-reflector -n 200 --no-pager | grep -i "bag"
```

Beklenen satırlar:

```
[peer] bag eklendi: DVPX-DE#3 (203.0.113.9:62071)
[peer] bag AYAKTA: DVPX-DE#3 (203.0.113.9:62071)
```

`bag AYAKTA` gördüyseniz o reflektörle TG'ler ortaktır: aynı TG'de olan
kullanıcılar iki sunucuda da birbirini duyar.

`bag DUSTU` görüyorsanız karşı taraf yanıt vermiyor. Sırayla bakın:
karşı reflektör çalışıyor mu, panelde onaylı mı, UDP 62071 karşı tarafta açık mı.

Hiç `bag` satırı yoksa: panel size peer listesi vermemiş demektir. Panelde
**Reflektörler** sayfasındaki **Bağ** kolonuna bakın; orada nedeni yazılıdır
(onaylı değil / token yok / uzun süredir sessiz).

### Kontrol 2 — Portlar gerçekten dinleniyor mu?

```bash
ss -tulpn | grep -E "62070|62071"
```

**Görmeniz gereken** (iki satır — biri tcp, biri udp):

```
tcp   LISTEN 0  511   0.0.0.0:62070   0.0.0.0:*   users:(("node",pid=12847,fd=20))
udp   UNCONN 0  0     0.0.0.0:62071   0.0.0.0:*   users:(("node",pid=12847,fd=18))
```

### Kontrol 3 — Dışarıdan erişilebiliyor mu?

Bu en önemli kontroldür ve **kendi bilgisayarınızdan** yapılır, sunucudan
değil. Yeni bir PowerShell/Terminal penceresi açın:

```bash
nc -vz dvpx.ornek.com 62070
```

(`dvpx.ornek.com` yerine kendi adresinizi yazın.)

**Görmeniz gereken:**

```
Connection to dvpx.ornek.com port 62070 [tcp] succeeded!
```

`nc` komutu Windows'ta yoksa PowerShell'de şunu kullanın:

```powershell
Test-NetConnection dvpx.ornek.com -Port 62070
```

`TcpTestSucceeded : True` görmelisiniz.

**Başarısız olduysa** sorun neredeyse kesin olarak güvenlik duvarıdır — Adım
6'ya, özellikle "sağlayıcınızın panelindeki güvenlik duvarı" kısmına dönün.

> UDP'yi bu şekilde test etmek güvenilir değildir (UDP yanıt vermez). TCP
> geçtiyse ve UDP kuralını da aynı şekilde eklediyseniz büyük olasılıkla
> sorunsuzdur; kesin kanıt bir uygulamayla konuşmaktır.

### Kontrol 4 — Panelde görünüyor mu?

Yöneticiye sorun ya da kendiniz kontrol edin: panelin **Reflektörler**
sayfasında satırınızda şunlar olmalı:

- **ONAYLI** yazan yeşil bir etiket,
- **● az önce** biçiminde yeşil bir "Son Haber" değeri,
- adın yanında **▲** işareti (= uygulamalara dağıtılıyor).

Son test: bir Digi Voice uygulamasında DVPX protokolünü seçin; sunucu
listesinde reflektörünüz görünmeli. Bağlanıp bir TG seçtiğinizde panelin
**Son Duyulanlar** sayfasında konuşmanız anında görünür.

---

## 12. Sorun Giderme

### Hata mesajına göre çözüm tablosu

Reflektör hataları anlaşılır yazmaya çalışır. Mesajı buradan bulun:

| Log'da gördüğünüz | Anlamı | Çözüm |
|---|---|---|
| `dashboard.url ve dashboard.token ZORUNLUDUR` | `config.json` eksik ya da bulunamadı | Adım 5'i tekrarlayın. Dosyanın `dvpx-reflector/` içinde ve adının tam olarak `config.json` olduğundan emin olun |
| `config.json ESKI SURUME ait` | Dosyada eski `database` bloğu var | `database` bloğunu silin, yerine `dashboard` bloğunu yazın |
| `gecerli JSON degil` | Yazım hatası | Fazla virgül / eksik tırnak arayın. Panelin verdiği metni yeniden yapıştırın |
| `Bu token taninmiyor` | Token yanlış veya iptal edilmiş | Yöneticiden yeni token isteyin. Kopyalarken başına/sonuna boşluk almadığınızdan emin olun |
| `REFLEKTOR ONAY BEKLIYOR` | Token doğru, ama yönetici onaylamamış | Yöneticiye haber verin. Onayladığı an **kendiliğinden** hizmete girer, bir şey yapmanız gerekmez |
| `panele ulasilamadi ... onbellekte politika yok` | İnternet/adres sorunu | Aşağıdaki "Panele ulaşılamıyor" bölümü |
| `panelden beklenmeyen yanit ... HTTP 404` | Adres yanlış | `dashboard.url` sonunda `/reflector.php` olmalı |
| `panel HTML dondurdu` | Adres panelin ana sayfasını gösteriyor | Aynı: adresin `reflector.php` ile bittiğinden emin olun |
| `PORT UYUSMAZLIGI` | Panelde yazan port ile dinlediğiniz port farklı | Ya `config.json`'daki portu, ya panelde kayıtlı portu düzeltin — ikisi aynı olmalı |
| `cannot bind TCP ... EADDRINUSE` | Port başka bir program tarafından kullanılıyor | `ss -tulpn \| grep 62070` ile bulun. Genelde reflektörün ikinci bir kopyası çalışıyordur: `systemctl stop dvpx-reflector` |
| `cannot bind TCP ... EACCES` | 1024'ten küçük bir port seçilmiş | 1024'ten büyük port kullanın (varsayılan 62070/62071 uygundur) |
| `panelde "offline" durumunda` | Yönetici yayımlamayı kapatmış | Reflektör çalışıyor ama uygulamalara dağıtılmıyor. Yöneticiye sorun |
| `KILITLENDI` | Panel token'ı reddetti | Yöneticiden yeni token isteyin |

### Panele ulaşılamıyor

Sırayla test edin. Bu komutlar **sunucuda** çalıştırılır:

**1. İnternet var mı?**

```bash
ping -c 3 1.1.1.1
```

**2. Alan adı çözümleniyor mu?**

```bash
ping -c 3 digivoice.algsoft.net.tr
```

`Name or service not known` derse DNS sorunu vardır.

**3. Panelin API'si yanıt veriyor mu?** (En yararlı test.)

```bash
curl -sS "https://dvpx.algsoft.net.tr/reflector.php?action=ping"
```

**Görmeniz gereken:**

```json
{"ok":true,"protocol":"DVPX","endpoint":"reflector-control","api":1,...}
```

- **Bunu görüyorsanız** adres doğru; sorun token'da veya onaydadır.
- **Boş çıktı / bağlantı hatası** → sunucunuzun dışa çıkışı engelli olabilir.
  Nadirdir, ama bazı sağlayıcılar giden bağlantıları kısıtlar.
- **HTML çıktı** → adres yanlış. Yöneticiden panelin Reflektörler sayfasında
  yazan tam adresi isteyin.
- **`certificate` içeren bir hata** → panelin SSL sertifikası geçersiz.
  Yöneticinin düzeltmesi gerekir.

**4. Token'ı doğrudan test edin:**

```bash
curl -sS -H "X-DVPX-Token: BURAYA_TOKEN" \
     "https://dvpx.algsoft.net.tr/reflector.php?action=snapshot"
```

TG listenizi içeren bir JSON dönerse token geçerli demektir.

### Kullanıcılar bağlanamıyor ama log temiz

Neredeyse her zaman güvenlik duvarı. Sırayla:

1. `ufw status` → 62070/tcp ve 62071/udp görünüyor mu?
2. Sağlayıcının web panelindeki güvenlik duvarı → aynı kurallar var mı?
3. Kendi bilgisayarınızdan `nc -vz ADRES 62070` → başarılı mı?
4. Panelde kayıtlı adres/port, gerçekten sizin sunucunuz mu? (Bir harf hatası
   yeterlidir.)

### Ses gitmiyor / karşı taraf duymuyor

Sinyalleşme (TCP) çalışıp ses (UDP) çalışmıyorsa **UDP portu kapalıdır.** TCP
kuralını eklerken UDP'yi atlamak çok yaygındır:

```bash
ufw allow 62071/udp
```

ve sağlayıcının panelinde de aynısını yapın. Log'da şunu izleyin:

```bash
journalctl -u dvpx-reflector -f | grep stats
```

`rx 0` (hiç paket gelmiyor) → UDP portu kapalı.
`rx` artıyor ama `fwd 0` → paket geliyor, iletilmiyor: kullanıcılar aynı TG'ye
abone değil olabilir.

### Panel çöktü / internet gitti, ne olur?

**Reflektör çalışmaya devam eder.** Ses akar, kullanıcılar giriş yapabilir;
reflektör elindeki son politikayı (TG listesi, engelliler) kullanır.
Bildirimler kuyrukta bekler ve bağlantı dönünce gönderilir — çağrı kayıtları
kaybolmaz.

Log'da şunu görürsünüz:

```
[contr] panel erisilemiyor; ses yonlendirme ve girisler ONBELLEKTEKI politika ile SURUYOR.
```

Bağlantı dönünce:

```
[contr] panel baglantisi geri geldi / dashboard reachable again
```

Tek istisna: panelin **açıkça** token'ı reddetmesi (iptal/onay kaldırma). O
durumda reflektör kilitlenir — bu kasıtlı bir davranıştır, ağdan çıkarmanın
yolu budur.

---

## 13. Günlük kullanım: komut kartı

```bash
# Surum (config gerekmez; yalnizca numarayi yazar)
node /opt/dvpx-reflector/src/index.js -v

# Durum
systemctl status dvpx-reflector

# Canlı log izle (Ctrl+C ile çık)
journalctl -u dvpx-reflector -f

# Son 100 satır
journalctl -u dvpx-reflector -n 100 --no-pager

# Yalnızca hataları göster
journalctl -u dvpx-reflector -p err --no-pager

# Yeniden başlat (config.json değiştirdikten sonra GEREKİR)
systemctl restart dvpx-reflector

# Durdur / başlat
systemctl stop dvpx-reflector
systemctl start dvpx-reflector

# Sunucu açılışında otomatik başlamayı kapat
systemctl disable dvpx-reflector

# Dinlenen portlar
ss -tulpn | grep -E "62070|62071"

# Kaç kişi bağlı? (istatistik satırı dakikada bir yazılır)
journalctl -u dvpx-reflector -n 200 --no-pager | grep stats | tail -3
```

**`config.json` her değişikliğinden sonra yeniden başlatmayı unutmayın.**
Reflektör dosyayı yalnızca açılışta okur.

---

## 14. Güncelleme

Yeni bir DVPX sürümü çıktığında ya da panel yöneticisi size **güncelleme emri**
gönderdiğinde (panonuzda kırmızı bir uyarı olarak görürsünüz) bu bölümü
uygulayın. İşlem 2–3 dakika sürer ve bu sürede reflektörünüz ağdan düşer.

### Önce yedek

`config.json` sizin dosyanızdır; güncellemeler ona dokunmaz (depoda
tutulmadığı için `git pull` de üzerine yazmaz). Yine de bir yedek bir
dakikanızı alır ve token'ı yeniden istemek zorunda kalmanızı önler:

```bash
cp /opt/dvpx-reflector/config.json ~/config.json.yedek
```

### Yol A — Git ile kurduysanız (önerilen)

Git kurulu değilse:

```bash
sudo apt install -y git
```

Sonra beş komut:

```bash
sudo systemctl stop dvpx-reflector
cd /opt/dvpx-reflector
sudo git pull
sudo chown -R dvpx:dvpx /opt/dvpx-reflector
sudo systemctl start dvpx-reflector
```

> `git pull` komutunu **`/opt/dvpx-reflector` içinde** çalıştırın. Başka bir
> dizinde `not a git repository` hatası alırsınız.

**Hiç git ile kurmadıysanız** (dizin bir depo değilse) bir kereye mahsus
yeniden klonlayabilirsiniz — `config.json`'ınız korunur:

```bash
sudo systemctl stop dvpx-reflector
sudo mv /opt/dvpx-reflector /opt/dvpx-reflector.eski
sudo git clone https://github.com/cektor/DVPX.git /opt/dvpx-reflector
sudo cp /opt/dvpx-reflector.eski/config.json /opt/dvpx-reflector/
sudo chown -R dvpx:dvpx /opt/dvpx-reflector
sudo chmod 600 /opt/dvpx-reflector/config.json
sudo systemctl start dvpx-reflector
```

Her şeyin çalıştığını gördükten sonra eski klasörü silebilirsiniz:
`sudo rm -rf /opt/dvpx-reflector.eski`

### Yol B — Elle kurduysanız

Yeni dosyaları aynı yere kopyalayın:

```bash
sudo systemctl stop dvpx-reflector
# yeni zip'i açıp içindekileri /opt/dvpx-reflector üzerine kopyalayın
sudo chown -R dvpx:dvpx /opt/dvpx-reflector
sudo systemctl start dvpx-reflector
```

> ⚠️ **DİKKAT:** `config.json` dosyanızın ÜZERİNE YAZILMAMASINA dikkat edin.
> Yazıldıysa yedekten geri koyun: `sudo cp ~/config.json.yedek
> /opt/dvpx-reflector/config.json`

### Güncellendiğini doğrulayın

```bash
node /opt/dvpx-reflector/src/index.js -v
systemctl status dvpx-reflector
journalctl -u dvpx-reflector -n 30 --no-pager
```

İlk komut yeni sürüm numarasını yazmalı, servis `active (running)` olmalı ve
log'da `DVPX reflector is ready. 73!` satırı görünmeli.

Panel yöneticisi size güncelleme emri gönderdiyse: reflektör yeni sürümü
panele bildirdiği an (en fazla birkaç dakika) panonuzdaki **kırmızı uyarı
kendiliğinden kalkar.** Bir düğmeye basmanız ya da yöneticiye haber vermeniz
gerekmez. Uyarı kalkmıyorsa güncelleme gerçekten uygulanmamıştır — yukarıdaki
`-v` çıktısını kontrol edin.

---

## 15. Sık sorulanlar

**Panel kurmam gerekiyor mu?**
Hayır. Panel ağın merkezinde, tek bir yerde çalışır ve ağ yöneticisi
tarafından işletilir. Siz yalnızca reflektör kuruyorsunuz.

**Veritabanı kurmam gerekiyor mu?**
Hayır. Reflektörün veritabanı ile hiçbir ilişkisi yoktur. MySQL kurmayın.

**`npm install` çalıştırmalı mıyım?**
Hayır. Reflektörün dış bağımlılığı yoktur. Sadece Node.js 18+ yeterlidir.

**Talkgroup oluşturabilir miyim? Kullanıcı engelleyebilir miyim?**
Hayır, bunlar panelde yapılır ve ağ yöneticisine aittir. Sizin reflektörünüz
panelin kararlarını uygular. Yeni bir TG isterseniz yöneticiye söylersiniz;
açtığı an (birkaç saniye içinde) reflektörünüzde de etkin olur —
yeniden başlatmak gerekmez.

**Aynı sunucuda iki reflektör çalıştırabilir miyim?**
Teknik olarak evet: her biri için ayrı bir dizin, ayrı `config.json`, ayrı
token ve **farklı portlar** (ör. 62070/62071 ve 62080/62081) gerekir. Ama pek
anlamı yoktur — bir reflektör yüzlerce kullanıcı taşır.

**Token'ı kaybettim.**
Yöneticiden yenisini istemeniz gerekir; token panelde saklanmaz (yalnızca
şifreli özeti tutulur), bu yüzden kimse eskisini geri getiremez. Yeni token
üretildiği an eskisi geçersiz olur.

**Reflektörümü kapatmak istiyorum.**
```bash
systemctl stop dvpx-reflector
systemctl disable dvpx-reflector
```
Yöneticiye de haber verin; panelden kaydınızı silsin. Kapattığınızda panel
sizi 2 dakika içinde "bayat" sayar ve kullanıcılara sunmayı otomatik olarak
keser — kimse ölü bir adrese bağlanmaya çalışmaz.

**Sunucumun IP'si değişti.**
Yöneticiye söyleyin, panelde adresi güncellemesi gerekir. Yeni token gerekmez.

**Log'lar diski doldurur mu?**
Log'lar systemd'nin journal'ına gider ve otomatik olarak döndürülür. Sınırı
küçültmek isterseniz:
```bash
journalctl --vacuum-size=200M
```

**Kaç kullanıcı taşıyabilir?**
`maxSessions` varsayılanı 500'dür. Ses trafiği kullanıcı başına yaklaşık
20 kbit/s'dir; 100 eşzamanlı dinleyici ≈ 2 Mbit/s. Darboğaz neredeyse her
zaman bant genişliğidir, CPU değil.

---

## 16. Reflektörler arası bağ (TG'ler ortak)

### Ne yapar?

DVPX'te bir konuşma grubu (TG) **tek bir reflektöre ait değildir.** Siz kendi
reflektörünüzde TG 286'da iken, başka bir reflektördeki bir arkadaşınız da TG
286'da ise **birbirinizi duyarsınız ve konuşabilirsiniz.** Özel çağrılar da
ağ genelindedir: aradığınız kişi hangi reflektörde kayıtlıysa çağrı orada çalar.

### Ne yapmanız gerekiyor?

**Hiçbir şey.** Bağ kendiliğinden kurulur. Tek koşul, her iki reflektörün de:

1. **Panelde onaylı** olması (Reflektörler → ✓ düğmesi),
2. **Token'ı** olması (⚿ ile üretilir),
3. Son 10 dakika içinde **panele haber vermiş** olması (yani çalışıyor olması).

Panel bu üç koşulu sağlayan her reflektöre diğerlerinin listesini ve her çift
için bir **paylaşılan anahtar** verir. Anahtarları elle paylaşmanız, bir dosyaya
yazmanız ya da arkadaşınıza göndermeniz **gerekmez** — panelde görünmezler bile.

Yeni bir reflektör onaylandığında bağ **saniyeler içinde** kurulur; servisi
yeniden başlatmanız gerekmez.

### Güvenlik

- Peer çerçevelerinin **her biri** HMAC-SHA256 ile imzalanır. İmzası doğrulanmayan
  hiçbir ses kabul edilmez; UDP portunuzu bilen biri TG'lerinize ses enjekte
  **edemez**.
- Peer'dan gelen ses **başka peer'a iletilmez**. Bu kural, tüm reflektörler
  birbirine bağlı olsa bile ses döngüsünü imkânsız kılar.
- Kayıtlı trafiğin tekrar oynatılmasına karşı ±30 saniyelik zaman damgası
  penceresi vardır. Sunucunuzda **NTP açık olsun** (`timedatectl` ile bakın);
  saat kayması bağın kurulmasını engeller.
- Anahtarlar `policy.cache.json` dosyasında saklanır ve bu dosya `0600`
  izinleriyle yazılır (yalnızca reflektörü çalıştıran kullanıcı okuyabilir).

### İnce ayar (gerekmez, ama mümkün)
NOT: Burdaki Ayarlar sunucunuz da belirlenen şekilde kalmalıdır değiştirilmemelidir.
Hiçbir engel olmamalıdır. Aksi taktirde reklektörünüz sistemden silinir TG leriniz kapatılır.

`config.json` içine `peers` bloğu ekleyebilirsiniz:

```json
"peers": {
  "enabled": true,
  "bridgeTalkgroups": "all",
  "bridgePrivateTalkgroups": true,
  "bridgePrivateCalls": true,
  "packetsPerSecond": 5000
}
```

| Ayar | Anlamı |
|---|---|
| `enabled: false` | Bağı tamamen kapatır — reflektörünüz yalnız çalışır, diğerlerindeki aynı TG duyulmaz. |
| `bridgeTalkgroups: [9, 286]` | Yalnızca bu TG'ler köprülenir; gerisi yerel kalır. |
| `bridgePrivateTalkgroups: false` | Özel (private) TG'ler köprülenmez. |
| `bridgePrivateCalls: false` | Özel çağrılar diğer reflektörlere iletilmez. |

Ayrıca `DVPX_PEERS=0` ortam değişkeni de bağı kapatır (hızlı test için).

### Bant genişliği

Bir konuşma 20 ms'de bir ~66 baytlık paket üretir (≈26 kbit/s). Peer çerçevesi
32 bayt başlık ekler → peer başına **≈40 kbit/s per aktif konuşma**. Üç
reflektörlü bir ağda tek konuşmacı için giden trafik ≈80 kbit/s'dir; sıradan bir
VPS için ihmal edilebilir.

---

## Yardım isterken

Şu üç şeyi birlikte gönderin, sorun genelde ilk bakışta anlaşılır:

```bash
# 1) Log (token içermez, güvenle paylaşabilirsiniz)
journalctl -u dvpx-reflector -n 60 --no-pager

# 2) config.json — TOKEN SATIRINI SİLEREK paylaşın!
cat /opt/dvpx-reflector/config.json

# 3) Portlar
ss -tulpn | grep -E "62070|62071"
```

> ⚠️ `config.json` içeriğini paylaşırken **token satırını mutlaka silin veya
> yıldızlayın.** Token'a sahip olan kişi ağa sizin reflektörünüz gibi
> katılabilir.

Kolay gelsin. 73!

−·· ···− ·−· −··−


Digi Voice Geliştiricisi
Fatih ÖNDER TB1TFO
Telegram: @tb1tfo
info@fatihonder.org.tr
https://fatihonder.org.tr

Şirket: ALGSoft Inc.
info@algsoft.net.tr
https://algsoft.net.tr

QRV73.com Amateur Radio Platform
iletisim@qrv73.com
https://qrv73.com

QRZ73.org.tr Amateur Radio CallBook 
info@qrz73.org.tr
https://qrz73.org.tr