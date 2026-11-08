# Guide d'installation DABcast

## Chemins installés par le .deb

| Élément | Chemin |
|---|---|
| Binaire | `/opt/dabcast/bin/dabcast` |
| Interface web | `/opt/dabcast/web/` |
| Preset démo (défaut) | `/opt/dabcast/defaults/demo.json` |
| Service systemd | `/lib/systemd/system/dabcast.service` |
| Config environnement | `/etc/default/dabcast` |
| Données (presets, logs…) | `/var/lib/dabcast/` |
| Log d'installation | `/var/log/dabcast-install.log` |

## Utilisateur système

Le service tourne sous un utilisateur existant de la machine, configuré dans `/etc/default/dabcast`.
**Aucun utilisateur n'est créé** — l'utilisateur doit déjà exister avant l'installation.

```bash
# Vérifier que l'utilisateur configuré existe
grep RUN_AS_USER /etc/default/dabcast
id odr   # remplacer odr par le nom configuré
```

## Variables d'environnement (service)

Éditer `/etc/default/dabcast` **avant** (ou juste après) l'installation, puis `sudo systemctl restart dabcast` :

```
# Utilisateur qui exécute le service (doit exister sur la machine)
RUN_AS_USER=odr

# Répertoire des données (presets, logs, runtime, mot)
DABCAST_DATA_DIR=/var/lib/dabcast

# Port et adresse d'écoute (défaut : 9090)
PORT=9090
HOST=0.0.0.0

# Pour le bouton Dablin (optionnel, si interface graphique)
DISPLAY=:0
XAUTHORITY=/home/USER/.Xauthority
XDG_RUNTIME_DIR=/run/user/1000
```

Après modification : `sudo systemctl restart dabcast`

## Diagnostic rapide après installation

```bash
# 1. Lire le log d'installation
cat /var/log/dabcast-install.log

# 2. Statut du service
sudo systemctl status dabcast

# 3. Logs du service (50 dernières lignes)
sudo journalctl -u dabcast -n 50 --no-pager

# 4. Tester le binaire manuellement (remplacer USER par la valeur de RUN_AS_USER)
sudo -u USER env DABCAST_DATA_DIR=/var/lib/dabcast /opt/dabcast/bin/dabcast

# 5. Vérifier que le port est libre
ss -tlnp | grep 9090

# 6. Vérifier les permissions des données
ls -la /var/lib/dabcast/
stat /opt/dabcast/bin/dabcast
```

## Problèmes courants

### Le service démarre puis s'arrête immédiatement (`status=1/FAILURE`)

```bash
sudo journalctl -u dabcast -n 30 --no-pager
```

Causes fréquentes :

| Symptôme dans les logs | Cause | Solution |
|---|---|---|
| `EADDRINUSE` / `address already in use` | Le port 9090 est occupé | `ss -tlnp \| grep 9090` — changer `PORT=` dans `/etc/default/dabcast` |
| `permission denied, mkdir …` | `DABCAST_DATA_DIR` non défini, accès refusé | Vérifier que `/etc/default/dabcast` contient `DABCAST_DATA_DIR=/var/lib/dabcast` |
| `Exec format error` | Binaire mauvaise architecture (ARM vs x64) | Voir section ci-dessous |
| `cannot open shared object` | Bibliothèque native manquante | `ldd /opt/dabcast/bin/dabcast` |

### Vérifier l'architecture du binaire

Le paquet `amd64` ne fonctionne **pas** sur Raspberry Pi (ARM).

```bash
# Architecture de la machine cible
dpkg --print-architecture
uname -m

# Type du binaire installé
file /opt/dabcast/bin/dabcast
```

Si la machine est ARM, il faut recompiler pour la bonne cible dans `build.sh` :

```bash
# node18-linux-x64   → amd64 (PC standard)
# node18-linux-arm64 → Raspberry Pi 64 bits
# node18-linux-armv7 → Raspberry Pi 32 bits
```

### Le service ne démarre pas automatiquement après installation

```bash
# Vérifier que le service est activé
systemctl is-enabled dabcast

# Activer manuellement si nécessaire
sudo systemctl enable dabcast
sudo systemctl start dabcast
```

### Réinstallation propre

```bash
# Supprimer complètement (efface aussi /var/lib/dabcast)
sudo dpkg --purge dabcast

# Réinstaller
sudo dpkg -i dabcast_X.Y.Z_amd64.deb
```

## Structure complète après installation

```
/opt/dabcast/
├── bin/
│   └── dabcast          ← binaire auto-contenu (Node.js 18 embarqué, ~50-80 MB)
├── web/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── defaults/
    └── demo.json        ← preset démo (copié dans /var/lib/dabcast/presets/ au 1er démarrage)

/var/lib/dabcast/        ← propriété RUN_AS_USER (mode 750)
├── settings.json        ← créé au 1er démarrage
├── presets/             ← presets utilisateur
├── logs/
│   └── dabweb.log       ← log applicatif (rotation automatique)
├── runtime/             ← état en cours (pids.json, current.mux…)
└── mot/                 ← images MOT par service (XXXX/ = code PI)

/lib/systemd/system/dabcast.service
/etc/default/dabcast
/var/log/dabcast-install.log  ← log du script postinst
```
