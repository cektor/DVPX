#!/usr/bin/env bash
#
# DVPX Updater — reflektörü SSH'a girmeden, panelden gelen bir emirle günceller.
#
# ┌────────────────────────────────────────────────────────────────────────┐
# │ BU BETİK dvpx-reflector SERVİSİNDEN TAMAMEN BAĞIMSIZDIR.                │
# │ Ayrı, root ile çalışan bir systemd zamanlayıcısı (dvpx-updater.timer)   │
# │ tarafından tetiklenir. Ana ses/sinyal süreci (internetten gelen         │
# │ paketleri işleyen, dolayısıyla saldırı yüzeyi en geniş kod) bu betiğe   │
# │ HİÇ DOKUNMAZ — bir tarafın açığı diğerinin root yetkisine sıçramaz.     │
# └────────────────────────────────────────────────────────────────────────┘
#
# Ne yapar (sırayla):
#   1) updater.php'ye sorar: "bekleyen bir emrin var mı?" (evet/hayır).
#   2) Evetse: origin'den YEREL updater.json'da tanımlı dala göre çeker.
#      Yeni bir şey yoksa burada durur (servise DOKUNULMAZ).
#   3) Yeni bir şey varsa: servisi durdurur, git reset --hard ile günceller,
#      izinleri düzeltir, servisi başlatır, birkaç saniye sonra sağlıklı mı
#      diye bakar.
#   4) Sağlıksızsa ÖNCEKİ commit'e geri döner ve servisi yeniden başlatır.
#   5) Sonucu (başarılı/başarısız, hangi sürüm) panele bildirir — operatör
#      SSH'a girmeden panelden görebilsin diye.
#
# ASLA YAPMADIĞI:
#   - "git clean" çalıştırmak. config.json ve policy.cache.json repoda
#     İZLENMEZ (bkz. ../../.gitignore); "reset --hard" onlara dokunmaz ama
#     "clean" SİLERDİ. Bu yüzden clean'e asla izin verilmez.
#   - Panelden gelen bir URL, dal adı ya da komut çalıştırmak. updater.php
#     yanıtı yalnızca "bekliyor/beklemiyor" bilgisi taşır (bkz. dashboard/
#     updater.php); git uzak adresi ve dalı HER ZAMAN bu sunucudaki
#     updater.json dosyasından okunur.

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${DVPX_UPDATER_CONFIG:-$SELF_DIR/updater.json}"
LOCK_FILE="/run/dvpx-updater.lock"
TAG="dvpx-updater"

log()  { echo "[$TAG] $*"; }
warn() { echo "[$TAG] UYARI: $*" >&2; }
die()  { echo "[$TAG] HATA: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root ile calistirilmali (systemd birimi User=root olmali)"
[ -f "$CONFIG_FILE" ] || die "config bulunamadi: $CONFIG_FILE (bkz. updater.json.example)"
command -v curl >/dev/null      || die "curl kurulu degil"
command -v git  >/dev/null      || die "git kurulu degil (sudo apt install -y git)"
command -v systemctl >/dev/null || die "systemctl bulunamadi (systemd gerekir)"

# ── updater.json'dan basit alan okuma ────────────────────────────────────
# Bağımlılık eklememek için jq/python KULLANMIYORUZ: JSON düz, tek seviyeli
# ve biçimi biz kontrol ediyoruz (bkz. servers.php'nin ürettiği örnek).
#
# NOT: grep bir eslesme BULAMAZSA 1 ile cikar. `set -o pipefail` altinda bu,
# asagidaki fonksiyonlarin donus degerini de 1 yapardi — ve bu fonksiyonlar
# cagiran tarafta duz bir atama icinde kullanildigi icin (bir `if` kosulu
# DEGIL), `set -e` betigi SESSIZCE, HICBIR MESAJ YAZMADAN sonlandirirdi
# (ornegin panel "ok" alani icermeyen bozuk bir yanit donduğunde). Bu yuzden
# grep'in "bulamadim" durumunu `|| true` ile ZARARSIZ hale getiriyoruz; alan
# gercekten yoksa fonksiyon temiz bir bos dize doner, cagiran taraf bunu
# acikca kontrol edip ANLAMLI bir hata basar.
json_str() {
    local key="$1" file="$2"
    { grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$file" || true; } | head -n1 \
        | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'
}
json_bool() {
    local key="$1" file="$2"
    { grep -oE "\"$key\"[[:space:]]*:[[:space:]]*(true|false)" "$file" || true; } | head -n1 \
        | sed -E 's/.*:[[:space:]]*//'
}
# Bir metni JSON dize değeri olarak kaçış kodlar (tırnak İÇERMEZ — çağıran
# taraf ekler). Saf bash parametre genişletmesi kullanır: boş girdi (`""`)
# bir "satırı" olmayan bir akışı sed/awk'a boru ile göndermenin aksine, boş
# fakat GEÇERLİ bir sonuç üretir — bu, sürüm bilinmediğinde JSON'un
# `"version":,` gibi bozulmamasını garanti eder.
json_escape() {
    local s="${1:-}"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '%s' "$s"
}

DASHBOARD_URL="$(json_str dashboardUrl "$CONFIG_FILE")"
UPDATER_TOKEN="$(json_str updaterToken "$CONFIG_FILE")"
REFLECTOR_DIR="$(json_str reflectorDir "$CONFIG_FILE")"
GIT_REMOTE="$(json_str gitRemote "$CONFIG_FILE")"
GIT_BRANCH="$(json_str gitBranch "$CONFIG_FILE")"

[ -n "$DASHBOARD_URL" ]  || die "updater.json: dashboardUrl eksik"
[ -n "$UPDATER_TOKEN" ]  || die "updater.json: updaterToken eksik"
REFLECTOR_DIR="${REFLECTOR_DIR:-/opt/dvpx-reflector}"
GIT_REMOTE="${GIT_REMOTE:-https://github.com/cektor/DVPX.git}"
GIT_BRANCH="${GIT_BRANCH:-main}"
[ -d "$REFLECTOR_DIR" ] || die "reflectorDir yok: $REFLECTOR_DIR"

SERVICE_USER="$(stat -c '%U' "$REFLECTOR_DIR" 2>/dev/null || echo dvpx)"

# ── Aynı anda iki kopya çalışmasın (zamanlayıcı üst üste binerse) ────────
exec 9>"$LOCK_FILE"
flock -n 9 || { log "onceki calisma hala surüyor, bu turu atliyorum"; exit 0; }

# ── Panele "sonuç" bildirir. Hata olsa bile betiğin geri kalanını durdurmaz. ─
report() {
    local applied="$1" version note v n
    version="${2:-}"
    note="${3:-}"
    v="$(json_escape "$version")"
    n="$(json_escape "$note")"
    curl -sS -m 15 -X POST "$DASHBOARD_URL" \
        -H "X-DVPX-Token: $UPDATER_TOKEN" \
        -H 'Content-Type: application/json' \
        -d "{\"result\":{\"applied\":${applied},\"version\":\"${v}\",\"note\":\"${n}\"}}" \
        >/dev/null 2>&1 || warn "sonuc panele bildirilemedi (gecici sorun olabilir)"
}

reflector_version() {
    (cd "$REFLECTOR_DIR" && timeout 10 node src/index.js -v 2>/dev/null) || echo ""
}

# ── 1) Bekleyen emir var mı? ──────────────────────────────────────────────
CHECK_BODY="$(curl -sS -m 15 -X POST "$DASHBOARD_URL" \
    -H "X-DVPX-Token: $UPDATER_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{}' 2>/dev/null)" || die "panele ulasilamadi: $DASHBOARD_URL"

# `ok` alanini AYRICA kontrol ediyoruz: aksi halde token iptal/gecersiz
# olunca panel {"ok":false,...} doner, "pending" alani hic bulunmaz ve
# PENDING bos kalir — bu da "bekleyen emir yok" ile AYNI GORUNUR. Operatör
# boylece token'inin gecersiz oldugunu ASLA OGRENEMEZDI (journalctl'de bile
# hicbir iz kalmazdi). Acikca ayirt ediyoruz.
OK_FIELD="$(printf '%s' "$CHECK_BODY" | json_bool ok /dev/stdin)"
if [ "$OK_FIELD" != "true" ]; then
    die "panel istegi reddetti (token gecersiz/iptal edilmis olabilir): $CHECK_BODY"
fi

PENDING="$(printf '%s' "$CHECK_BODY" | json_bool pending /dev/stdin)"
if [ "$PENDING" != "true" ]; then
    log "bekleyen emir yok, cikiliyor"
    exit 0
fi

TARGET="$(printf '%s' "$CHECK_BODY" | json_str target /dev/stdin)"
log "guncelleme emri var (hedef: ${TARGET:-?}) — kontrol ediliyor"

# ── 2) Yeni bir şey var mı? (servise DOKUNMADAN önce bak) ────────────────
if [ ! -d "$REFLECTOR_DIR/.git" ]; then
    log "git deposu yok, mevcut kurulum git'e bagliyor (ilk kurulumdan kalma dosyalar KORUNUR)"
    git -C "$REFLECTOR_DIR" init -q
    git -C "$REFLECTOR_DIR" remote add origin "$GIT_REMOTE"
else
    # Uzak adres HER ZAMAN bu sunucudaki updater.json'dan gelir; panelden
    # ASLA. Operatör updater.json'u degistirmedigi surece bu satirin bir
    # etkisi yoktur.
    git -C "$REFLECTOR_DIR" remote set-url origin "$GIT_REMOTE" 2>/dev/null \
        || git -C "$REFLECTOR_DIR" remote add origin "$GIT_REMOTE"
fi

git -C "$REFLECTOR_DIR" fetch origin "$GIT_BRANCH" --quiet \
    || die "git fetch basarisiz ($GIT_REMOTE / $GIT_BRANCH)"

NEW_HEAD="$(git -C "$REFLECTOR_DIR" rev-parse "origin/$GIT_BRANCH")"
# `git rev-parse HEAD` bir "unborn branch" (hic commit yok — az once bootstrap
# edilmis bir kurulum) uzerinde basarisiz OLUR ama basarisiz olurken stdout'a
# yine de "HEAD" YAZAR (git'in kendine has bir davranisi). Bu, `... || echo ''`
# ile yakalanamaz: komut ikamesi basarisiz komutun ONCEDEN yazdigi "HEAD"
# metnini de tasir ve PREV_HEAD sessizce "HEAD" STRING'ine esitlenir — geri
# alma sirasinda "git reset --hard HEAD" gibi bir HICBIR SEY YAPMAYAN komutla
# sonuclanirdi. `--verify -q` byle durumlarda stdout'a HICBIR SEY yazmaz.
PREV_HEAD="$(git -C "$REFLECTOR_DIR" rev-parse --verify -q HEAD 2>/dev/null || true)"

if [ -n "$PREV_HEAD" ] && [ "$PREV_HEAD" = "$NEW_HEAD" ]; then
    log "zaten guncel (${NEW_HEAD:0:8}); servise dokunulmadi"
    report true "$(reflector_version)" "already current (${NEW_HEAD:0:8})"
    exit 0
fi

log "guncelleniyor: ${PREV_HEAD:0:8} -> ${NEW_HEAD:0:8}"

# ── 3) Uygula ─────────────────────────────────────────────────────────────
apply_and_check() {
    local rev="$1"
    # NOT: bu fonksiyon `if apply_and_check ...` icinde cagirildigi icin bash
    # `errexit`i (set -e) fonksiyon govdesi boyunca DEVRE DISI birakir. Yani
    # her adimin basarisi `|| return 1` ile ACIKCA kontrol edilmeli — aksi
    # halde ornegin "git reset" sessizce basarisiz olur, betik eskisini
    # (yanlis surumu) baslatip "saglikli" diye rapor edebilirdi.
    systemctl stop dvpx-reflector 2>/dev/null || true
    # "git clean" YOK: config.json ve policy.cache.json izlenmeyen dosyalardir
    # (bkz. .gitignore) — reset --hard onlara dokunmaz, clean SILERDI.
    git -C "$REFLECTOR_DIR" reset --hard "$rev" --quiet || return 1
    chown -R "$SERVICE_USER":"$SERVICE_USER" "$REFLECTOR_DIR" 2>/dev/null || true
    systemctl start dvpx-reflector || return 1
    sleep 8
    systemctl is-active --quiet dvpx-reflector
}

if apply_and_check "$NEW_HEAD"; then
    VERSION="$(reflector_version)"
    log "basarili, surum: ${VERSION:-?}"
    report true "$VERSION" "updated ${PREV_HEAD:0:8} -> ${NEW_HEAD:0:8}"
    exit 0
fi

warn "yeni surum saglikli baslamadi, ${PREV_HEAD:0:8} surumune donuluyor"
if [ -n "$PREV_HEAD" ] && apply_and_check "$PREV_HEAD"; then
    warn "geri alindi ve calisiyor: ${PREV_HEAD:0:8}"
    report false "$(reflector_version)" "FAILED at ${NEW_HEAD:0:8}, rolled back to ${PREV_HEAD:0:8}"
else
    warn "geri alma da basarisiz oldu — journalctl -u dvpx-reflector -n 50 kontrol edin"
    report false "$(reflector_version)" "FAILED at ${NEW_HEAD:0:8}, rollback ALSO failed"
fi
exit 1
