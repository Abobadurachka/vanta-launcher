import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Activity, ArrowDownToLine, Box, Check, ChevronDown, CircleHelp, Cpu, Download,
  ExternalLink, FolderOpen, Gamepad2, HardDrive, Layers3, Loader2, MemoryStick,
  Package, Play, Plus, Puzzle, RefreshCw, Search, Settings2, ShieldCheck, Sparkles,
  Trash2, Upload, X, Zap, Wrench, CheckCircle2, AlertTriangle, XCircle, ClipboardCheck, History,
  ArrowUpRight, ChevronLeft, ChevronRight, SlidersHorizontal, CloudDownload,
  Volume2, VolumeX, ShieldCheck as DeveloperShield, Lock, LogOut, Terminal,
  Gauge, Server, KeyRound, RefreshCw as RefreshIcon, ShieldAlert, Users, UserPlus, Copy, Wifi, WifiOff, Link2,
} from 'lucide-react';
import type { LoaderType, ModItem, NebulaApi, Profile, Progress, Project, Runtime, VersionItem, LoaderVersions, ProfileCheckReport, LauncherUpdateState, DeveloperAdminOverview, DeveloperAdminStatus, UpdateFeedConfig, UpdateFeedTestResult, FriendsState, FriendPresence } from './types';
import vantaLogo from './assets/vanta.png';
import vantaWorld from './assets/vanta-world.png';

declare global { interface Window { nebula: NebulaApi } }

type Tab = 'home' | 'mods' | 'packs' | 'settings' | 'friends' | 'updates' | 'admin';
const loaderNames: Record<LoaderType, string> = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };
const fmt = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} ГБ` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(0)} МБ` : `${value} Б`;

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => { try { return localStorage.getItem('vanta.ui-sounds') !== 'off'; } catch { return true; } });
  const soundEnabledRef = useRef(soundEnabled);
  const audioContextRef = useRef<AudioContext | null>(null);

  const playUiSound = useCallback((kind: 'click' | 'success' | 'error' = 'click') => {
    if (!soundEnabledRef.current) return;
    try {
      const AudioContextCtor = window.AudioContext;
      if (!AudioContextCtor) return;
      const context = audioContextRef.current || (audioContextRef.current = new AudioContextCtor());
      if (context.state === 'suspended') void context.resume();
      const notes = kind === 'success' ? [660, 880] : kind === 'error' ? [220, 165] : [540];
      notes.forEach((frequency, index) => {
        const start = context.currentTime + index * 0.055;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = kind === 'click' ? 'triangle' : 'sine';
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(kind === 'click' ? 0.018 : 0.026, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + (kind === 'click' ? 0.075 : 0.17));
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.start(start); oscillator.stop(start + 0.19);
      });
    } catch { /* Audio is an optional UI enhancement; it must never affect launcher actions. */ }
  }, []);

  const toggleSounds = () => {
    const next = !soundEnabledRef.current;
    soundEnabledRef.current = next;
    setSoundEnabled(next);
    try { localStorage.setItem('vanta.ui-sounds', next ? 'on' : 'off'); } catch { /* optional preference */ }
    if (next) window.setTimeout(() => playUiSound('success'), 0);
  };

  const handleAppClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const button = (event.target as HTMLElement).closest('button');
    if (button && !button.disabled && !button.hasAttribute('data-silent')) playUiSound('click');
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [versions, setVersions] = useState<VersionItem[]>([]);
  const [mods, setMods] = useState<ModItem[]>([]);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [tab, setTab] = useState<Tab>('home');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [catalog, setCatalog] = useState<'mod' | 'modpack' | null>(null);
  const [username, setUsername] = useState('Player');
  const [hasCurseForgeApiKey, setHasCurseForgeApiKey] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [checkReport, setCheckReport] = useState<ProfileCheckReport | null>(null);
  const [checkingProfile, setCheckingProfile] = useState(false);
  const [booting, setBooting] = useState(true);
  const [updateState, setUpdateState] = useState<LauncherUpdateState | null>(null);
  const [friendsState, setFriendsState] = useState<FriendsState | null>(null);

  const selected = useMemo(() => profiles.find((profile) => profile.id === selectedId) || null, [profiles, selectedId]);
  const launcherVersion = updateState?.currentVersion || '…';
  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    playUiSound(error ? 'error' : 'success');
    window.setTimeout(() => setToast(null), 3600);
  }, [playUiSound]);

  const refreshState = useCallback(async () => {
    const state = await window.nebula.getState();
    setProfiles(state.profiles);
    setSelectedId(state.selectedProfileId || state.profiles[0]?.id || null);
    setShowSnapshots(state.showSnapshots);
    const list = await window.nebula.getVersions(state.showSnapshots).catch(() => []);
    setVersions(list);
  }, []);

  const refreshModsAndRuntime = useCallback(async (profile: Profile) => {
    const [items, info] = await Promise.all([
      window.nebula.listMods(profile.id).catch(() => []),
      window.nebula.getRuntimeInfo(profile.id).catch(() => null)
    ]);
    setMods(items);
    setRuntime(info);
  }, []);

  useEffect(() => {
    refreshState().catch((error) => notify(error.message || 'Не удалось загрузить лаунчер', true));
    window.nebula.hasCurseForgeApiKey().then(setHasCurseForgeApiKey).catch(() => undefined);
    window.nebula.getFriendsState().then(setFriendsState).catch(() => undefined);
    const unsubscribeFriends = window.nebula.onFriendsState(setFriendsState);
    const unsubscribe = window.nebula.onProgress((event) => {
      setProgress(event);
      if (event.done) {
        setBusy(false);
        if (event.error) notify(event.message, true);
        else if (event.task !== 'game-log') notify(event.message);
        if (event.task === 'launch' && event.error && selectedId) {
          window.nebula.diagnoseProfile(selectedId).then(setCheckReport).catch(() => undefined);
        }
        refreshState().catch(() => undefined);
        setRefreshKey((value) => value + 1);
      } else if (event.task !== 'game-log') setBusy(true);
    });
    return () => { unsubscribe(); unsubscribeFriends(); };
  }, [refreshState, notify, selectedId]);

  useEffect(() => {
    const unsubscribe = window.nebula.onUpdateStatus(setUpdateState);
    window.nebula.getUpdateState().then(setUpdateState).catch(() => undefined);
    const splashTimer = window.setTimeout(() => setBooting(false), 2850);
    return () => { unsubscribe(); window.clearTimeout(splashTimer); };
  }, []);

  useEffect(() => { setCheckReport(null); }, [selectedId]);

  useEffect(() => {
    if (selected) refreshModsAndRuntime(selected);
    else { setMods([]); setRuntime(null); }
  }, [selectedId, selected?.id, refreshKey, refreshModsAndRuntime]);

  const run = async (action: () => Promise<unknown>, successMessage?: string) => {
    try {
      await action();
      if (successMessage) notify(successMessage);
      await refreshState();
      setRefreshKey((value) => value + 1);
    } catch (error: any) {
      notify(error?.message || 'Операция не выполнена', true);
      setBusy(false);
    }
  };

  const chooseProfile = async (id: string) => {
    await window.nebula.selectProfile(id);
    setSelectedId(id);
  };

  const create = async (input: { name: string; minecraftVersion: string; loader: LoaderType; loaderVersion: string }) => {
    const profile = await window.nebula.createProfile(input);
    setCreateOpen(false);
    await refreshState();
    setSelectedId(profile.id);
    setTab('home');
    notify(`Профиль «${profile.name}» создан`);
  };

  const importMods = async () => {
    if (!selected) return;
    const imported = await window.nebula.importMods(selected.id);
    await refreshModsAndRuntime(selected);
    if (imported.length) notify(`Импортировано файлов: ${imported.length}`);
  };

  const importPack = async () => {
    if (!selected) return;
    const result = await window.nebula.importPack(selected.id);
    if (result) {
      notify(`Сборка «${result.packName}»: ${result.modsInstalled} JAR-модов`);
      await refreshState();
      setRefreshKey((value) => value + 1);
    }
  };

  const install = async () => {
    if (!selected) return;
    setBusy(true);
    await run(() => window.nebula.installProfile(selected.id));
    const report = await window.nebula.diagnoseProfile(selected.id).catch(() => null);
    if (report) setCheckReport(report);
  };

  const launch = async () => {
    if (!selected) return;
    setBusy(true);
    await run(async () => {
      try {
        return await window.nebula.launchProfile(selected.id, username);
      } catch (error) {
        const report = await window.nebula.diagnoseProfile(selected.id).catch(() => null);
        if (report) setCheckReport(report);
        throw error;
      }
    });
  };

  const diagnose = async () => {
    if (!selected) return;
    setCheckingProfile(true);
    try {
      const report = await window.nebula.diagnoseProfile(selected.id);
      setCheckReport(report);
      notify(report.ready ? 'Проверка завершена: проблем не найдено.' : 'Проверка завершена: найдены пункты для восстановления.', !report.ready);
    } catch (error: any) {
      notify(error?.message || 'Не удалось выполнить проверку', true);
    } finally {
      setCheckingProfile(false);
    }
  };

  const repair = async () => {
    if (!selected) return;
    setBusy(true);
    await run(async () => {
      const report = await window.nebula.repairProfile(selected.id);
      setCheckReport(report);
      return report;
    }, 'Сборка восстановлена. Проверка пройдена.');
  };

  const changeMemory = async (memoryMb: number) => {
    if (!selected) return;
    const clamped = Math.max(1024, Math.min(memoryMb, runtime?.totalMemoryMb ? runtime.totalMemoryMb - 512 : 32768));
    const updated = await window.nebula.updateProfile(selected.id, { memoryMb: clamped });
    setProfiles((list) => list.map((item) => item.id === selected.id ? updated : item));
  };

  const refreshFriends = async () => setFriendsState(await window.nebula.getFriendsState());
  const addFriend = async (code: string, name: string) => {
    const result = await window.nebula.addFriend(code, name);
    setFriendsState(result.state);
    notify(`Друг «${result.added.name}» добавлен`);
  };
  const removeFriend = async (friend: FriendPresence) => {
    if (!window.confirm(`Удалить «${friend.name}» из списка друзей?`)) return;
    setFriendsState(await window.nebula.removeFriend(friend.code));
    notify('Друг удалён из списка');
  };
  const joinFriend = async (friend: FriendPresence) => {
    if (!friend.hosting || !friend.address || !friend.port || !friend.minecraftVersion || !friend.loader) return;
    const compatible = profiles.find((item) => item.installed && item.minecraftVersion === friend.minecraftVersion && item.loader === friend.loader && (item.loaderVersion || '') === (friend.loaderVersion || ''));
    if (!compatible) {
      notify(`Нужен установленный профиль ${friend.minecraftVersion} · ${loaderNames[friend.loader]}. Создай его в VANTA.`, true);
      return;
    }
    setBusy(true);
    await run(() => window.nebula.joinFriend(compatible.id, friend.code, username));
  };
  const setManualPort = async (port: number | null) => setFriendsState(await window.nebula.setManualLanPort(port));

  const sideItems: Array<{ id: Tab; title: string; icon: typeof Play }> = [
    { id: 'home', title: 'Главная', icon: Gamepad2 },
    { id: 'mods', title: 'Моды', icon: Puzzle },
    { id: 'packs', title: 'Сборки', icon: Package },
    { id: 'friends', title: 'Друзья', icon: Users },
    { id: 'settings', title: 'Память и Java', icon: Cpu },
    { id: 'updates', title: 'Обновления', icon: History },
    { id: 'admin', title: 'Админ-панель', icon: DeveloperShield }
  ];

  return (
    <div className="app-shell" onClickCapture={handleAppClick}>
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark"><img src={vantaLogo} alt="Vanta" /></div>
          <div><div className="brand-name">VANTA</div><div className="brand-sub">MINECRAFT CLIENT <em>STABLE CHANNEL</em></div></div>
        </div>
        <div className="sidebar-label">НАВИГАЦИЯ</div>
        <nav className="side-nav">
          {sideItems.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={`nav-item ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}>
              <Icon size={17} strokeWidth={1.8} /><span>{item.title}</span>{tab === item.id && <i className="nav-indicator" />}
            </button>;
          })}
        </nav>
        <div className="profile-head"><span>ПРОФИЛИ</span><button title="Создать профиль" onClick={() => setCreateOpen(true)}><Plus size={15} /></button></div>
        <div className="profile-list">
          {profiles.map((profile) => <button key={profile.id} className={`profile-entry ${selectedId === profile.id ? 'selected' : ''}`} onClick={() => chooseProfile(profile.id)}>
            <div className={`profile-cube ${profile.loader}`}><Box size={16} /></div>
            <div className="profile-copy"><b>{profile.name}</b><span>{profile.minecraftVersion} · {loaderNames[profile.loader]}</span></div>
            {profile.installed && <span className="profile-dot" />}
          </button>)}
          {profiles.length === 0 && <div className="empty-profiles">Профилей пока нет.<br />Создай первый, чтобы начать.</div>}
        </div>
        <div className="sidebar-bottom">
          <div className="connection-status"><span className="status-pulse" /> СИСТЕМА ГОТОВА</div>
          <div className="sidebar-version">VANTA CLIENT <span>v{launcherVersion}</span></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>VANTA</span><b>/</b><strong>{sideItems.find((item) => item.id === tab)?.title}</strong></div>
          <div className="topbar-right">
            <button className={`sound-toggle ${soundEnabled ? 'is-on' : ''}`} onClick={toggleSounds} title={soundEnabled ? 'Отключить звуки интерфейса' : 'Включить звуки интерфейса'} aria-label={soundEnabled ? 'Отключить звуки' : 'Включить звуки'}>{soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}</button>
            <div className="top-version"><span className="tiny-green-dot" /> {selected ? `Minecraft ${selected.minecraftVersion}` : 'Профиль не выбран'}</div>
            <div className="avatar">V</div>
          </div>
        </header>
        <div className="page-content" key={tab}>
          {updateState?.status === 'available' && <div className="update-banner"><div className="update-banner-icon"><Sparkles size={19} /></div><div><b>Вышла новая версия лаунчера · {updateState.availableVersion}</b><span>Установлена версия {launcherVersion} · Vanta Stable</span>{updateState.notes.length > 0 ? <ul className="update-banner-notes">{updateState.notes.slice(0, 2).map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}</ul> : <span>Для этого релиза разработчик не добавил описание изменений.</span>}</div><button onClick={() => void window.nebula.downloadUpdate()}><CloudDownload size={15} /> ОБНОВИТЬ ДО {updateState.availableVersion}</button></div>}
          {updateState?.status === 'downloaded' && <div className="update-banner downloaded"><div className="update-banner-icon"><CheckCircle2 size={19} /></div><div><b>Обновление {updateState.availableVersion} скачано</b><span>Текущая версия {launcherVersion} · перезапусти лаунчер, чтобы применить обновление</span>{updateState.notes.length > 0 ? <ul className="update-banner-notes">{updateState.notes.slice(0, 2).map((note, index) => <li key={`${index}-${note}`}>{note}</li>)}</ul> : <span>Для этого релиза разработчик не добавил описание изменений.</span>}</div><button onClick={() => void window.nebula.installUpdate()}><RefreshCw size={15} /> УСТАНОВИТЬ {updateState.availableVersion}</button></div>}
          {tab === 'home' && <HomeView profile={selected} runtime={runtime} username={username} setUsername={setUsername} progress={progress} busy={busy} checkReport={checkReport} checkingProfile={checkingProfile} onDiagnose={diagnose} onRepair={repair} onInstall={install} onLaunch={launch} onCreate={() => setCreateOpen(true)} onDelete={async () => {
            if (!selected || !window.confirm(`Удалить профиль «${selected.name}» и его файлы?`)) return;
            const state = await window.nebula.deleteProfile(selected.id);
            setProfiles(state.profiles); setSelectedId(state.selectedProfileId); notify('Профиль удалён');
          }} />}
          {tab === 'mods' && <ModsView profile={selected} mods={mods} onImport={importMods} onCatalog={() => setCatalog('mod')} onRefresh={() => selected && refreshModsAndRuntime(selected)} onToggle={async (mod) => {
            if (!selected) return;
            await window.nebula.toggleMod(selected.id, mod.file, !mod.enabled); await refreshModsAndRuntime(selected);
          }} onDelete={async (mod) => {
            if (!selected || !window.confirm(`Удалить мод ${mod.name}?`)) return;
            await window.nebula.deleteMod(selected.id, mod.file); await refreshModsAndRuntime(selected); notify('Мод удалён');
          }} />}
          {tab === 'packs' && <PacksView profile={selected} progress={progress} onCatalog={() => setCatalog('modpack')} onImport={importPack} />}
          {tab === 'friends' && <FriendsView state={friendsState} profiles={profiles} onAdd={addFriend} onRemove={removeFriend} onJoin={joinFriend} onManualPort={setManualPort} notify={notify} />}
          {tab === 'updates' && <UpdatesView state={updateState} onCheck={async () => setUpdateState(await window.nebula.checkUpdates())} onDownload={async () => { await window.nebula.downloadUpdate(); }} onInstall={() => void window.nebula.installUpdate()} onConfigure={() => setTab('admin')} />}
          {tab === 'admin' && <DeveloperAdminPanel notify={notify} />}
          {tab === 'settings' && <SettingsView profile={selected} runtime={runtime} showSnapshots={showSnapshots} hasCurseForgeApiKey={hasCurseForgeApiKey} onOpenLog={async () => { try { await window.nebula.openErrorLog(); notify('Журнал ошибок открыт'); } catch (error: any) { notify(error.message || 'Не удалось открыть журнал', true); } }} onInstallJava={async () => { if (!selected) return; setBusy(true); await run(() => window.nebula.installJavaRuntime(selected.id)); }} onSaveCurseForgeKey={async (value) => { await window.nebula.setCurseForgeApiKey(value); setHasCurseForgeApiKey(Boolean(value.trim())); notify('Ключ CurseForge сохранён в защищённом хранилище'); }} onMemory={changeMemory} onSave={async (patch) => {
            if (!selected) return;
            const updated = await window.nebula.updateProfile(selected.id, patch);
            setProfiles((list) => list.map((item) => item.id === updated.id ? updated : item));
            notify('Настройки сохранены');
            setRefreshKey((value) => value + 1);
          }} onChooseJava={async () => {
            if (!selected) return;
            const java = await window.nebula.chooseJava();
            if (java) {
              const updated = await window.nebula.updateProfile(selected.id, { javaPath: java });
              setProfiles((list) => list.map((item) => item.id === updated.id ? updated : item));
              setRuntime(await window.nebula.getRuntimeInfo(updated.id));
              notify('Путь к Java обновлён');
            }
          }} onSnapshots={async (value) => {
            setShowSnapshots(value); await window.nebula.setShowSnapshots(value);
            setVersions(await window.nebula.getVersions(value));
          }} />}
        </div>
        <footer className="bottom-bar">
          <div className="bottom-left"><span className="tiny-green-dot" /> VANTA SERVICES <span className="muted">· Mojang / Fabric / Modrinth</span></div>
          <div className="bottom-right"><span>JAVA EDITION</span><span className="bottom-sep" /> <span>{runtime?.javaFound ? `JAVA ${runtime.javaMajor || ''}` : 'JAVA НЕ НАЙДЕНА'}</span></div>
        </footer>
      </main>

      {booting && <SplashScreen version={launcherVersion} />}
      {createOpen && <CreateProfileModal versions={versions} onClose={() => setCreateOpen(false)} onCreate={create} />}
      {catalog && selected && <CatalogModal type={catalog} profile={selected} onClose={() => setCatalog(null)} onInstalled={async (message) => {
        setCatalog(null); notify(message); await refreshState(); setRefreshKey((value) => value + 1);
      }} />}
      {toast && <div className={`toast ${toast.error ? 'error' : ''}`}><span className="toast-icon">{toast.error ? <X size={16} /> : <Check size={16} />}</span>{toast.message}</div>}
    </div>
  );
}

function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-orbit"><Box size={27} /></div><h3>{title}</h3><p>{description}</p>{action}</div>;
}

function ProgressCard({ progress }: { progress: Progress | null }) {
  if (!progress || !['install', 'repair', 'runtime', 'pack-import', 'pack', 'modrinth'].includes(progress.task) || progress.done) return null;
  return <div className="progress-card">
    <div className="progress-card-head"><span><Loader2 className="spin" size={15} /> {progress.message}</span><b>{progress.percent}%</b></div>
    <div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div>
    <div className="progress-meta"><span>VANTA TRANSFER ENGINE</span><span>Параллельная загрузка · проверка SHA-1</span></div>
  </div>;
}

function BuildHealthCard({ report, checking, busy, onDiagnose, onRepair }: {
  report: ProfileCheckReport | null; checking: boolean; busy: boolean; onDiagnose: () => void; onRepair: () => void;
}) {
  const okCount = report?.checks.filter((item) => item.status === 'ok').length || 0;
  const issueCount = report?.checks.filter((item) => item.status !== 'ok').length || 0;
  return <section className="glass-panel health-panel">
    <div className="health-heading">
      <div className="panel-heading"><div><span className="panel-kicker">BUILD INTEGRITY · AUTO RECOVERY</span><h3>Проверка и восстановление</h3></div><ClipboardCheck size={19} className="panel-icon" /></div>
      <div className="health-actions">
        <button className="outline-button" onClick={onDiagnose} disabled={busy || checking}><ClipboardCheck size={14} /> {checking ? 'ПРОВЕРКА…' : 'ПРОВЕРИТЬ СБОРКУ'}</button>
        <button className="repair-button" onClick={onRepair} disabled={busy || checking}><Wrench size={14} /> {busy ? 'ВОССТАНОВЛЕНИЕ…' : 'ПОЧИНИТЬ СБОРКУ'}</button>
      </div>
    </div>
    {!report ? <div className="health-empty"><ShieldCheck size={19} /><div><b>Диагностика ещё не запускалась</b><span>Проверим Java, базовую версию, профиль Forge/Fabric, библиотеки и ресурсы.</span></div></div> : <>
      <div className={`health-summary ${report.ready ? 'healthy' : 'needs-repair'}`}>
        <div className="health-summary-icon">{report.ready ? <CheckCircle2 size={19} /> : <AlertTriangle size={19} />}</div>
        <div><b>{report.ready ? 'Сборка готова к запуску' : 'Обнаружены проблемы или незавершённые шаги'}</b><span>{okCount} пройдено · {issueCount} замечаний · {new Date(report.checkedAt).toLocaleTimeString('ru-RU')}</span></div>
      </div>
      <div className="health-check-list">
        {report.checks.map((item) => <div className="health-check-row" key={item.id}>
          <span className={`health-check-icon ${item.status}`}>{item.status === 'ok' ? <CheckCircle2 size={15} /> : item.status === 'warning' ? <AlertTriangle size={15} /> : <XCircle size={15} />}</span>
          <div><b>{item.label}</b><span>{item.detail}</span></div>
          <small>{item.status === 'ok' ? 'OK' : item.status === 'warning' ? 'ВНИМАНИЕ' : 'ОШИБКА'}</small>
        </div>)}
      </div>
    </>}
    <div className="health-footnote"><ShieldCheck size={13} /> Повреждённые и отсутствующие файлы можно восстановить. Личные сохранения и папка worlds не удаляются.</div>
  </section>;
}

function HomeView({ profile, runtime, username, setUsername, progress, busy, checkReport, checkingProfile, onDiagnose, onRepair, onInstall, onLaunch, onCreate, onDelete }: {
  profile: Profile | null; runtime: Runtime | null; username: string; setUsername: (value: string) => void; progress: Progress | null; busy: boolean;
  checkReport: ProfileCheckReport | null; checkingProfile: boolean; onDiagnose: () => void; onRepair: () => void;
  onInstall: () => void; onLaunch: () => void; onCreate: () => void; onDelete: () => void;
}) {
  if (!profile) return <EmptyState title="Добро пожаловать в Vanta" description="Создай игровой профиль, выбери версию Minecraft и загрузчик — лаунчер подготовит файлы автоматически." action={<button className="primary-button" onClick={onCreate}><Plus size={17} /> СОЗДАТЬ ПРОФИЛЬ</button>} />;
  return <div className="home-layout">
    <section className="hero-card" style={{ '--hero-image': `url("${vantaWorld}")` } as CSSProperties}>
      <div className="hero-grid" />
      <div className="hero-glow one" /><div className="hero-glow two" />
      <div className="hero-content">
        <div className="eyebrow"><span className="eyebrow-line" /> ТВОЯ ИГРОВАЯ ВСЕЛЕННАЯ</div>
        <h1>ГОТОВ К<br /><em>ПОГРУЖЕНИЮ?</em></h1>
        <p>Твой Minecraft. Твои правила. Никаких лишних границ.</p>
        <div className="hero-meta">
          <div><span>ВЕРСИЯ</span><b>{profile.minecraftVersion}</b></div><i />
          <div><span>ЗАГРУЗЧИК</span><b>{loaderNames[profile.loader]}</b></div><i />
          <div><span>ОЗУ</span><b>{(profile.memoryMb / 1024).toFixed(1)} ГБ</b></div>
        </div>
        {profile.installed ? <div className="hero-actions">
          <button className="play-button" onClick={onLaunch} disabled={busy}><Play size={21} fill="currentColor" /><span>ИГРАТЬ</span><i /></button>
          <div className="player-field"><span>ИГРОК</span><input value={username} onChange={(event) => setUsername(event.target.value)} maxLength={16} placeholder="Player" /></div>
        </div> : <button className="play-button install-button" onClick={onInstall} disabled={busy}><Download size={19} /><span>УСТАНОВИТЬ ПРОФИЛЬ</span><i /></button>}
        <ProgressCard progress={progress} />
      </div>
      <div className="hero-art"><div className="planet-ring ring-a" /><div className="planet-ring ring-b" /><div className="planet"><div className="planet-shade" /><div className="planet-land land-a" /><div className="planet-land land-b" /><div className="planet-crater crater-a" /><div className="planet-crater crater-b" /></div><div className="orbit-dot" /><div className="star star-a">✦</div><div className="star star-b">✧</div><div className="star star-c">✦</div></div>
      <div className="hero-corner">N° 001 <span>—</span> INFINITE PLAY</div>
    </section>

    <div className="dashboard-grid">
      <section className="glass-panel profile-summary">
        <div className="panel-heading"><div><span className="panel-kicker">АКТИВНЫЙ ЭКЗЕМПЛЯР</span><h3>Игровой профиль</h3></div><span className={`status-pill ${profile.installed ? 'good' : 'warning'}`}><i /> {profile.installed ? 'УСТАНОВЛЕН' : 'НЕ УСТАНОВЛЕН'}</span></div>
        <div className="summary-name"><div className={`summary-icon ${profile.loader}`}><Layers3 size={21} /></div><div><b>{profile.name}</b><span>{profile.installedVersionId || `${profile.minecraftVersion}-${profile.loader}`}</span></div><button className="icon-button danger-icon" title="Удалить профиль" onClick={onDelete}><Trash2 size={16} /></button></div>
        <div className="summary-stats"><div><span>ИГРА</span><b>{profile.minecraftVersion}</b></div><div><span>ЗАГРУЗЧИК</span><b>{loaderNames[profile.loader]}</b></div><div><span>ПАМЯТЬ</span><b>{(profile.memoryMb / 1024).toFixed(1)} GB</b></div></div>
      </section>
      <section className="glass-panel runtime-summary">
        <div className="panel-heading"><div><span className="panel-kicker">СИСТЕМНАЯ ДИАГНОСТИКА</span><h3>Среда запуска</h3></div><Activity size={17} className="panel-icon" /></div>
        <div className="runtime-lines">
          <div><span><span className="tiny-green-dot" /> Операционная система</span><b>{runtime?.os || 'Определение...'}</b></div>
          <div><span><span className={runtime?.javaFound ? 'tiny-green-dot' : 'tiny-red-dot'} /> Java Runtime</span><b>{runtime?.javaFound ? `Java ${runtime.javaMajor}` : 'Не найдена'}</b></div>
          <div><span><span className="tiny-green-dot" /> Доступная ОЗУ</span><b>{runtime ? `${(runtime.totalMemoryMb / 1024).toFixed(1)} GB` : '—'}</b></div>
        </div>
      </section>
    </div>
    <BuildHealthCard report={checkReport} checking={checkingProfile} busy={busy} onDiagnose={onDiagnose} onRepair={onRepair} />
    <div className="home-note"><ShieldCheck size={16} /><span>Игровые файлы загружаются напрямую с официальных серверов Mojang. Офлайн-профиль подходит для одиночной игры; для серверов нужна авторизация Microsoft.</span></div>
  </div>;
}

function ModsView({ profile, mods, onImport, onCatalog, onRefresh, onToggle, onDelete }: {
  profile: Profile | null; mods: ModItem[]; onImport: () => void; onCatalog: () => void; onRefresh: () => void; onToggle: (mod: ModItem) => void; onDelete: (mod: ModItem) => void;
}) {
  if (!profile) return <EmptyState title="Сначала создай профиль" description="Моды устанавливаются отдельно для каждого игрового профиля." />;
  return <div className="section-layout">
    <div className="page-title-row"><div><div className="eyebrow"><span className="eyebrow-line" /> CUSTOM CONTENT</div><h1>МОДЫ<span className="title-dot">.</span></h1><p>Управляй дополнениями для {profile.minecraftVersion} · {loaderNames[profile.loader]}</p></div><div className="title-counter"><b>{mods.length.toString().padStart(2, '0')}</b><span>УСТАНОВЛЕНО</span></div></div>
    <div className="action-grid">
      <button className="action-tile featured" onClick={onCatalog}><div className="tile-icon cyan"><Search size={20} /></div><div><b>Каталог модов</b><span>Найди дополнения на Modrinth</span></div><ExternalLink size={16} className="tile-arrow" /></button>
      <button className="action-tile" onClick={onImport}><div className="tile-icon purple"><Upload size={20} /></div><div><b>Импорт мода (.jar)</b><span>Поддерживаемый формат: .jar</span></div><ArrowDownToLine size={16} className="tile-arrow" /></button>
    </div>
    <div className="list-heading"><div><h3>Установленные моды</h3><span>{mods.length} файлов в папке mods</span></div><button className="subtle-button" onClick={onRefresh}><RefreshCw size={14} /> ОБНОВИТЬ</button></div>
    {mods.length === 0 ? <EmptyState title="Здесь пока тихо" description="Добавь первый мод из каталога Modrinth или импортируй .jar с компьютера." action={<button className="outline-button" onClick={onCatalog}><Search size={15} /> ОТКРЫТЬ КАТАЛОГ</button>} /> : <div className="mods-list">
      {mods.map((mod) => <div className={`mod-row ${!mod.enabled ? 'disabled-mod' : ''}`} key={mod.file}>
        <div className="mod-symbol"><Puzzle size={18} /></div><div className="mod-details"><b>{mod.name}</b><span>{mod.file} · {fmt(mod.size)}</span></div>
        <span className={`mod-state ${mod.enabled ? 'enabled' : ''}`}>{mod.enabled ? 'ВКЛЮЧЁН' : 'ОТКЛЮЧЁН'}</span>
        <button className={`toggle-switch ${mod.enabled ? 'on' : ''}`} onClick={() => onToggle(mod)} title={mod.enabled ? 'Отключить' : 'Включить'}><i /></button>
        <button className="icon-button danger-icon" onClick={() => onDelete(mod)} title="Удалить"><Trash2 size={15} /></button>
      </div>)}
    </div>}
    <div className="folder-path"><FolderOpen size={14} /><span>{profile.gameDir}\mods</span></div>
  </div>;
}

function PacksView({ profile, progress, onCatalog, onImport }: { profile: Profile | null; progress: Progress | null; onCatalog: () => void; onImport: () => void }) {
  if (!profile) return <EmptyState title="Сначала создай профиль" description="Сборки устанавливаются в отдельную папку выбранного профиля." />;
  return <div className="section-layout">
    <div className="page-title-row"><div><div className="eyebrow"><span className="eyebrow-line" /> MODPACK MANAGER</div><h1>СБОРКИ<span className="title-dot">.</span></h1><p>Целые игровые миры — одним нажатием</p></div><div className="pack-badge"><Package size={24} /><span>MODRINTH<br />READY</span></div></div>
    <div className="pack-feature">
      <div className="pack-visual"><div className="pack-cube cube-one" /><div className="pack-cube cube-two" /><div className="pack-cube cube-three" /><div className="pack-orbit" /></div>
      <div className="pack-feature-text"><span className="panel-kicker">БЫСТРЫЙ СТАРТ</span><h2>Новый мир.<br /><em>Новый опыт.</em></h2><p>Устанавливай готовые наборы модов, настроек и ресурсов. Vanta распознаёт manifest и подготовит клиентские файлы автоматически.</p><button className="primary-button" onClick={onCatalog}><Search size={16} /> КАТАЛОГ СБОРОК</button></div>
    </div>
    <div className="action-grid one-col"><button className="action-tile" onClick={onImport}><div className="tile-icon purple"><Upload size={20} /></div><div><b>Импорт сборки (.zip)</b><span>Поддерживаемый формат: .zip (Modrinth .mrpack / CurseForge / стандартный архив)</span></div><ArrowDownToLine size={16} className="tile-arrow" /></button></div>
    <div className="pack-info-grid"><div className="glass-panel mini-info"><Layers3 size={18} /><b>Modrinth .mrpack</b><span>Manifest, зависимости и клиентские overrides</span></div><div className="glass-panel mini-info"><FolderOpen size={18} /><b>Обычный ZIP</b><span>Поиск mods/, config/, shaderpacks/ и resourcepacks/</span></div><div className="glass-panel mini-info"><ShieldCheck size={18} /><b>Безопасная распаковка</b><span>Проверка путей файлов и очистка временной папки</span></div></div>
    <ProgressCard progress={progress} />
  </div>;
}

function SettingsView({ profile, runtime, showSnapshots, hasCurseForgeApiKey, onOpenLog, onInstallJava, onSaveCurseForgeKey, onMemory, onSave, onChooseJava, onSnapshots }: {
  profile: Profile | null; runtime: Runtime | null; showSnapshots: boolean; hasCurseForgeApiKey: boolean; onOpenLog: () => void; onInstallJava: () => void; onSaveCurseForgeKey: (value: string) => void; onMemory: (value: number) => void; onSave: (patch: Partial<Profile>) => void; onChooseJava: () => void; onSnapshots: (value: boolean) => void;
}) {
  const [memory, setMemory] = useState(profile?.memoryMb || 4096);
  const [jvm, setJvm] = useState(profile?.jvmArgs || '');
  const [name, setName] = useState(profile?.name || '');
  const [curseKey, setCurseKey] = useState('');
  useEffect(() => { setMemory(profile?.memoryMb || 4096); setJvm(profile?.jvmArgs || ''); setName(profile?.name || ''); }, [profile?.id, profile?.memoryMb, profile?.jvmArgs, profile?.name]);
  if (!profile) return <EmptyState title="Нет активного профиля" description="Создай профиль, чтобы настроить его память и среду Java." />;
  const max = Math.max(2048, (runtime?.totalMemoryMb || 16384) - 1024);
  return <div className="section-layout settings-layout">
    <div className="page-title-row"><div><div className="eyebrow"><span className="eyebrow-line" /> PERFORMANCE CONTROL</div><h1>НАСТРОЙКИ<span className="title-dot">.</span></h1><p>Тонкая настройка окружения запуска</p></div><div className="settings-orb"><Settings2 size={25} /></div></div>
    <div className="settings-grid">
      <section className="glass-panel settings-card memory-card">
        <div className="panel-heading"><div><span className="panel-kicker">MEMORY ALLOCATION</span><h3>Выделение оперативной памяти</h3></div><MemoryStick size={19} className="panel-icon" /></div>
        <div className="memory-number"><strong>{(memory / 1024).toFixed(1)}</strong><span>ГБ</span><div className="memory-mb">{memory.toLocaleString('ru-RU')} MB</div></div>
        <input className="memory-slider" type="range" min="1024" max={max} step="512" value={Math.min(memory, max)} onChange={(event) => setMemory(Number(event.target.value))} style={{ '--slider-progress': `${((Math.min(memory, max) - 1024) / Math.max(1, max - 1024)) * 100}%` } as CSSProperties} />
        <div className="slider-labels"><span>1 ГБ</span><span>РЕКОМЕНДОВАНО 4–6 ГБ</span><span>{(max / 1024).toFixed(0)} ГБ</span></div>
        <div className="memory-input-row"><label>Точное значение, МБ<input type="number" min="1024" max={max} step="128" value={memory} onChange={(event) => setMemory(Number(event.target.value))} /></label><div className="memory-hint"><Cpu size={15} /><span>Всего в системе: {runtime ? (runtime.totalMemoryMb / 1024).toFixed(1) : '—'} ГБ</span></div></div>
        <button className="primary-button save-settings" onClick={() => onMemory(memory)}><Check size={15} /> ПРИМЕНИТЬ ПАМЯТЬ</button>
      </section>
      <section className="glass-panel settings-card java-card">
        <div className="panel-heading"><div><span className="panel-kicker">JAVA RUNTIME</span><h3>Среда исполнения</h3></div><Zap size={18} className="panel-icon" /></div>
        <div className="java-status"><div className={`java-logo ${runtime?.javaFound ? 'ready' : ''}`}>J</div><div><b>{runtime?.javaFound ? `Java ${runtime.javaMajor || ''}` : 'Java не обнаружена'}</b><span>{runtime?.javaFound ? runtime.javaVersion : `Для этой версии рекомендуется Java ${runtime?.recommendedJava || 21}`}</span></div><span className={`status-pill ${runtime?.javaFound ? 'good' : 'warning'}`}><i /> {runtime?.javaFound ? 'READY' : 'MISSING'}</span></div>
        <div className="java-path"><span>ПУТЬ К JAVA</span><b title={profile.javaPath || runtime?.javaPath || 'Автоматический поиск'}>{profile.javaPath || runtime?.javaPath || 'Автоматический поиск'}</b></div>
        <button className="outline-button choose-java" onClick={onChooseJava}><FolderOpen size={15} /> ВЫБРАТЬ JAVA</button>
        {runtime && (!runtime.javaFound || (runtime.javaMajor !== null && runtime.javaMajor < runtime.recommendedJava)) && <button className="primary-button choose-java" onClick={onInstallJava}><Download size={15} /> УСТАНОВИТЬ JAVA {runtime.recommendedJava}</button>}
        <div className="java-note"><CircleHelp size={15} /><span>Лаунчер автоматически ищет Java в системе и может загрузить Temurin JRE нужной версии. Для 1.20.5+ обычно нужна Java 21, для 1.18–1.20.4 — Java 17.</span></div>
      </section>
      <section className="glass-panel settings-card advanced-card">
        <div className="panel-heading"><div><span className="panel-kicker">JVM PARAMETERS</span><h3>Дополнительные аргументы</h3></div><Activity size={17} className="panel-icon" /></div>
        <label className="form-label">JVM аргументы<textarea value={jvm} onChange={(event) => setJvm(event.target.value)} rows={3} spellCheck={false} /></label>
        <label className="form-label profile-name-label">Имя профиля<input value={name} onChange={(event) => setName(event.target.value)} maxLength={32} /></label>
        <button className="outline-button" onClick={() => onSave({ jvmArgs: jvm, name })}><Check size={15} /> СОХРАНИТЬ НАСТРОЙКИ</button>
      </section>
      <section className="glass-panel settings-card version-card">
        <div className="panel-heading"><div><span className="panel-kicker">VERSION CHANNEL</span><h3>Снапшоты Minecraft</h3></div><Layers3 size={18} className="panel-icon" /></div>
        <p>Показывать экспериментальные сборки в списке доступных версий.</p>
        <button className={`toggle-switch ${showSnapshots ? 'on' : ''}`} onClick={() => onSnapshots(!showSnapshots)}><i /></button>
        <span className="setting-toggle-label">{showSnapshots ? 'Снапшоты включены' : 'Только стабильные релизы'}</span>
      </section>
      <section className="glass-panel settings-card curseforge-card">
        <div className="panel-heading"><div><span className="panel-kicker">EXTERNAL INTEGRATION</span><h3>CurseForge API</h3></div><ShieldCheck size={18} className="panel-icon" /></div>
        <p>Нужен только для загрузки модов из экспортированных CurseForge-сборок. Ключ хранится зашифрованным средствами Windows.</p>
        <label className="form-label">API-ключ<input type="password" value={curseKey} onChange={(event) => setCurseKey(event.target.value)} placeholder={hasCurseForgeApiKey ? 'Ключ уже сохранён · введи новый для замены' : 'Вставь API-ключ CurseForge'} autoComplete="off" /></label>
        <button className="outline-button" onClick={() => onSaveCurseForgeKey(curseKey)}><ShieldCheck size={14} /> СОХРАНИТЬ КЛЮЧ</button>
      </section>
      <section className="glass-panel settings-card diagnostics-card">
        <div className="panel-heading"><div><span className="panel-kicker">SUPPORT & DIAGNOSTICS</span><h3>Журнал ошибок</h3></div><Activity size={18} className="panel-icon" /></div>
        <p>Если установка профиля завершится ошибкой, открой журнал и отправь его содержимое для точной диагностики.</p>
        <button className="outline-button" onClick={onOpenLog}><FolderOpen size={15} /> ОТКРЫТЬ ЖУРНАЛ ОШИБОК</button>
      </section>
    </div>
  </div>;
}

function DeveloperAdminPanel({ notify }: { notify: (message: string, error?: boolean) => void }) {
  const [status, setStatus] = useState<DeveloperAdminStatus | null>(null);
  const [overview, setOverview] = useState<DeveloperAdminOverview | null>(null);
  const [logs, setLogs] = useState('');
  const [username, setUsername] = useState('developer');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [lockTick, setLockTick] = useState(0);
  const [feedProvider, setFeedProvider] = useState<'github' | 'generic'>('github');
  const [feedValue, setFeedValue] = useState('');
  const [feedBusy, setFeedBusy] = useState(false);
  const [feedTest, setFeedTest] = useState<UpdateFeedTestResult | null>(null);

  const buildFeedConfig = (): UpdateFeedConfig => {
    const value = feedValue.trim();
    if (feedProvider === 'generic') return { provider: 'generic', url: value };
    const raw = value.replace(/^https?:\/\/(?:www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
    const parts = raw.split('/').filter(Boolean);
    if (parts.length !== 2) throw new Error('Укажи GitHub-репозиторий в формате owner/repository.');
    return { provider: 'github', owner: parts[0], repo: parts[1] };
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const nextStatus = await window.nebula.adminStatus();
      setStatus(nextStatus);
      if (nextStatus.authenticated) {
        const [nextOverview, nextLogs, nextFeed] = await Promise.all([window.nebula.adminOverview(), window.nebula.adminLogs(), window.nebula.adminUpdateFeed()]);
        setOverview(nextOverview);
        setLogs(nextLogs);
        if (nextFeed?.provider === 'github') {
          setFeedProvider('github');
          setFeedValue(`${nextFeed.owner}/${nextFeed.repo}`);
        } else if (nextFeed?.provider === 'generic') {
          setFeedProvider('generic');
          setFeedValue(nextFeed.url);
        } else {
          setFeedProvider('github');
          setFeedValue('');
        }
      } else {
        setOverview(null);
        setLogs('');
      }
    } catch (error: any) {
      setOverview(null);
      notify(error?.message || 'Не удалось загрузить панель разработчика', true);
      const nextStatus = await window.nebula.adminStatus().catch(() => null);
      setStatus(nextStatus);
    } finally { setLoading(false); }
  }, [notify]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!status?.lockedForMs || status.lockedForMs <= 0) { setLockTick(0); return; }
    const deadline = Date.now() + status.lockedForMs;
    const timer = window.setInterval(() => {
      setLockTick((value) => value + 1);
      if (Date.now() >= deadline) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status?.lockedForMs]);

  const submitAuth = async (event: FormEvent) => {
    event.preventDefault();
    if (!status) return;
    if (!status.configured && password !== confirmPassword) {
      notify('Пароли не совпадают.', true);
      return;
    }
    setBusy(true);
    try {
      if (status.configured) await window.nebula.adminLogin(username, password);
      else await window.nebula.adminSetup(username, password);
      setPassword(''); setConfirmPassword('');
      await refresh();
      notify(status.configured ? 'Вход разработчика выполнен.' : 'Учётная запись разработчика создана.');
    } catch (error: any) { notify(error?.message || 'Ошибка авторизации', true); await refresh(); }
    finally { setBusy(false); }
  };

  const logout = async () => {
    await window.nebula.adminLogout();
    setPassword(''); setConfirmPassword('');
    await refresh();
    notify('Сеанс разработчика завершён.');
  };

  const openLog = async () => {
    try { await window.nebula.adminOpenLog(); notify('Журнал открыт.'); }
    catch (error: any) { notify(error?.message || 'Не удалось открыть журнал', true); }
  };

  const testFeed = async () => {
    setFeedBusy(true);
    setFeedTest(null);
    try {
      const result = await window.nebula.adminTestUpdateFeed(buildFeedConfig());
      setFeedTest(result);
      notify(result.message, !result.ok);
    } catch (error: any) {
      const result = { ok: false, ready: false, message: error?.message || 'Не удалось проверить канал.' };
      setFeedTest(result);
      notify(result.message, true);
    } finally { setFeedBusy(false); }
  };

  const saveFeed = async () => {
    setFeedBusy(true);
    try {
      const config = buildFeedConfig();
      await window.nebula.adminSetUpdateFeed(config);
      notify('Канал обновлений сохранён. Проверка запущена автоматически.');
      await refresh();
    } catch (error: any) {
      notify(error?.message || 'Не удалось сохранить канал обновлений.', true);
    } finally { setFeedBusy(false); }
  };

  const formatUptime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours} ч ${minutes} мин`;
  };
  const lockedForMs = Math.max(0, (status?.lockedForMs ?? 0) - lockTick * 1000);

  if (loading && !status) return <div className="section-layout admin-layout"><div className="admin-loading"><Loader2 className="spin" size={24} /> Загружаем защищённую панель…</div></div>;

  return <div className="section-layout admin-layout">
    <div className="admin-heading">
      <div><div className="eyebrow"><span className="eyebrow-line" /> VANTA INTERNAL / DEVELOPER CONSOLE</div><h1>ПАНЕЛЬ <em>РАЗРАБОТЧИКА</em><span className="title-dot">.</span></h1><p>Локальные инструменты обслуживания, диагностики и контроля среды лаунчера.</p></div>
      <div className="admin-heading-mark"><DeveloperShield size={28} /><span>LOCAL<br />ACCESS</span></div>
    </div>

    {!status?.configured || !status.authenticated ? <section className="admin-auth-card">
      <div className="admin-auth-art"><div className="admin-auth-orbit orbit-one"/><div className="admin-auth-orbit orbit-two"/><div className="admin-auth-emblem"><Lock size={34}/></div><span>SECURE DEVELOPER GATE</span></div>
      <div className="admin-auth-content">
        <span className="panel-kicker">{status?.configured ? 'IDENTITY VERIFICATION' : 'FIRST-TIME CONFIGURATION'}</span>
        <h2>{status?.configured ? 'Вход в консоль' : 'Создай доступ разработчика'}</h2>
        <p>{status?.configured ? 'Введи локальный логин и пароль для открытия внутренних инструментов Vanta.' : 'Первый запуск: создай логин и пароль. Пароль будет сохранён только в виде криптографического хеша в пользовательском профиле Windows.'}</p>
        <form className="admin-auth-form" onSubmit={submitAuth}>
          <label className="form-label">ЛОГИН<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={32} required /></label>
          <label className="form-label">ПАРОЛЬ<div className="admin-password-wrap"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={status?.configured ? 'current-password' : 'new-password'} minLength={10} maxLength={128} required/><button type="button" onClick={() => setShowPassword((value) => !value)}>{showPassword ? 'СКРЫТЬ' : 'ПОКАЗАТЬ'}</button></div></label>
          {!status?.configured && <label className="form-label">ПОВТОРИ ПАРОЛЬ<input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={10} maxLength={128} required /></label>}
          {lockedForMs > 0 && <div className="admin-lock-message"><ShieldAlert size={15}/> Слишком много попыток. Повтори через {Math.ceil(lockedForMs / 1000)} сек.</div>}
          <button className="admin-submit" type="submit" disabled={busy || lockedForMs > 0}><KeyRound size={16}/>{busy ? 'ПРОВЕРКА…' : status?.configured ? 'ВОЙТИ В ПАНЕЛЬ' : 'СОЗДАТЬ УЧЁТНУЮ ЗАПИСЬ'}</button>
        </form>
        <div className="admin-security-note"><ShieldCheck size={15}/><span>Защита: scrypt-хеш + случайная соль · блокировка после 5 ошибок · сеанс 15 минут. Пароль не отправляется в интернет.</span></div>
      </div>
    </section> : <>
      <div className="admin-session-bar"><div className="admin-session-dot"/><div><b>Доступ разрешён</b><span>Локальная сессия разработчика · автоматически истекает после 15 минут бездействия</span></div><button className="admin-ghost-button" onClick={refresh}><RefreshIcon size={15}/> ОБНОВИТЬ</button><button className="admin-logout-button" onClick={logout}><LogOut size={15}/> ВЫЙТИ</button></div>
      <div className="admin-stat-grid">
        <div className="admin-stat-card"><span>ВЕРСИЯ КЛИЕНТА</span><b>{overview?.appVersion || '—'}</b><small>STABLE RELEASE BUILD</small></div>
        <div className="admin-stat-card"><span>ПРОФИЛИ MINECRAFT</span><b>{overview?.profileCount ?? '—'}</b><small>{overview?.installedProfileCount ?? 0} УСТАНОВЛЕНО</small></div>
        <div className="admin-stat-card"><span>ВРЕМЯ РАБОТЫ</span><b>{overview ? formatUptime(overview.uptimeSeconds) : '—'}</b><small>ТЕКУЩИЙ СЕАНС</small></div>
        <div className="admin-stat-card"><span>КАНАЛ ОБНОВЛЕНИЙ</span><b className={overview?.releaseFeedConfigured ? 'admin-green' : 'admin-amber'}>{overview?.releaseFeedConfigured ? 'ПОДКЛЮЧЁН' : 'НЕ НАСТРОЕН'}</b><small>HTTPS RELEASE FEED</small></div>
      </div>
      <div className="admin-tools-grid">
        <section className="admin-tool-card">
          <div className="admin-tool-head"><div className="admin-tool-icon"><Gauge size={19}/></div><div><span className="panel-kicker">SYSTEM TELEMETRY</span><h3>Среда выполнения</h3></div></div>
          <div className="admin-data-rows"><div><span>Операционная система</span><b>{overview?.platform || '—'} · {overview?.architecture || '—'}</b></div><div><span>Electron</span><b>{overview?.electronVersion || '—'}</b></div><div><span>Node.js</span><b>{overview?.nodeVersion || '—'}</b></div><div><span>Режим</span><b>STABLE</b></div></div>
        </section>
        <section className="admin-tool-card">
          <div className="admin-tool-head"><div className="admin-tool-icon violet"><Server size={19}/></div><div><span className="panel-kicker">MAINTENANCE</span><h3>Обслуживание</h3></div></div>
          <p>Инструменты обслуживания локальной установки и проверки состояния разработческой сборки.</p>
          <div className="admin-tool-actions"><button className="admin-action-primary" onClick={() => void window.nebula.checkUpdates().then(() => notify('Проверка канала обновлений завершена.')).catch((error: any) => notify(error.message, true))}><RefreshIcon size={15}/> ПРОВЕРИТЬ ОБНОВЛЕНИЯ</button><button className="admin-action-secondary" onClick={openLog}><Terminal size={15}/> ОТКРЫТЬ ПОЛНЫЙ ЛОГ</button></div>
        </section>
      </div>
      <section className="admin-update-feed-card">
        <div className="admin-tool-head"><div className="admin-tool-icon"><CloudDownload size={19}/></div><div><span className="panel-kicker">LIVE UPDATE CHANNEL</span><h3>Подключение автообновлений</h3></div><span className={`feed-status-pill ${overview?.releaseFeedConfigured ? 'connected' : 'not-connected'}`}>{overview?.releaseFeedConfigured ? 'КАНАЛ СОХРАНЁН' : 'НЕ НАСТРОЕН'}</span></div>
        <p className="admin-feed-description">Укажи источник, из которого установленный VANTA будет получать новые сборки. Для GitHub нужен публичный репозиторий с опубликованным стабильным релизом; для HTTPS — каталог с latest.yml, установщиком и blockmap.</p>
        <div className="admin-feed-form">
          <label className="form-label">ТИП ИСТОЧНИКА
            <select value={feedProvider} onChange={(event) => { setFeedProvider(event.target.value as 'github' | 'generic'); setFeedTest(null); setFeedValue(''); }}>
              <option value="github">GitHub Releases · публичный репозиторий</option>
              <option value="generic">Собственный HTTPS release feed</option>
            </select>
          </label>
          <label className="form-label">{feedProvider === 'github' ? 'ССЫЛКА ИЛИ OWNER/REPOSITORY' : 'HTTPS-АДРЕС КАТАЛОГА РЕЛИЗОВ'}
            <input value={feedValue} onChange={(event) => { setFeedValue(event.target.value); setFeedTest(null); }} placeholder={feedProvider === 'github' ? 'https://github.com/owner/repository' : 'https://updates.example.net/vanta/windows/x64/'} spellCheck={false} />
          </label>
        </div>
        <div className="admin-feed-actions">
          <button className="admin-action-secondary" onClick={() => void testFeed()} disabled={feedBusy || !feedValue.trim()}><Activity size={15}/>{feedBusy ? 'ПРОВЕРКА…' : 'ПРОВЕРИТЬ ПОДКЛЮЧЕНИЕ'}</button>
          <button className="admin-action-primary" onClick={() => void saveFeed()} disabled={feedBusy || !feedValue.trim()}><Check size={15}/> СОХРАНИТЬ КАНАЛ</button>
        </div>
        {feedTest && <div className={`admin-feed-result ${feedTest.ready ? 'ready' : feedTest.ok ? 'warning' : 'failed'}`}><span>{feedTest.ready ? <CheckCircle2 size={16}/> : feedTest.ok ? <AlertTriangle size={16}/> : <XCircle size={16}/>}</span><div><b>{feedTest.ready ? 'Канал готов' : feedTest.ok ? 'Источник доступен, релиз ещё не готов' : 'Проверка не пройдена'}</b><p>{feedTest.message}</p></div></div>}
        <div className="admin-feed-footnote"><ShieldCheck size={14}/> GitHub-репозиторий должен быть публичным. Для публикации новой версии используй PUBLISH-GITHUB.bat: скрипт запросит токен локально и не вшивает его в приложение. После публикации канал проверяется при запуске и каждые 10 минут.</div>
      </section>
      <section className="admin-log-card">
        <div className="admin-tool-head"><div className="admin-tool-icon amber"><Terminal size={19}/></div><div><span className="panel-kicker">LIVE DIAGNOSTICS / LAST 100 LINES</span><h3>Журнал лаунчера</h3></div><button className="admin-refresh-log" onClick={refresh}><RefreshIcon size={15}/> ОБНОВИТЬ ЛОГ</button></div>
        <pre>{logs || 'Журнал пока пуст. Ошибки и события установки появятся здесь.'}</pre>
      </section>
      <div className="admin-footnote"><ShieldCheck size={15}/> Панель работает локально на этом компьютере. Учётная запись разработчика не является серверной авторизацией и не защищает файлы от другого пользователя Windows с доступом к этой учётной записи.</div>
    </>}
  </div>;
}

function CreateProfileModal({ versions, onClose, onCreate }: { versions: VersionItem[]; onClose: () => void; onCreate: (input: { name: string; minecraftVersion: string; loader: LoaderType; loaderVersion: string }) => void }) {
  const [name, setName] = useState('Мой Minecraft');
  const [version, setVersion] = useState(versions[0]?.id || '1.21.1');
  const [loader, setLoader] = useState<LoaderType>('vanilla');
  const [loaderVersion, setLoaderVersion] = useState('');
  const [loaderOptions, setLoaderOptions] = useState<LoaderVersions>({ fabric: [], forge: [], neoforge: [] });
  const [loadingLoaders, setLoadingLoaders] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (loader === 'vanilla') { setLoaderVersion(''); setLoadingLoaders(false); return; }
    setLoadingLoaders(true);
    setLoaderOptions({ fabric: [], forge: [], neoforge: [] });
    window.nebula.getLoaderVersions(version).then((options) => {
      if (cancelled) return;
      setLoaderOptions(options);
      const values = options[loader];
      setLoaderVersion(values?.[0] || '');
    }).catch(() => {
      if (!cancelled) { setLoaderOptions({ fabric: [], forge: [], neoforge: [] }); setLoaderVersion(''); }
    }).finally(() => { if (!cancelled) setLoadingLoaders(false); });
    return () => { cancelled = true; };
  }, [version, loader]);
  const options = loader === 'vanilla' ? [] : loaderOptions[loader];
  const loaderSupported = loader === 'vanilla' || options.length > 0;
  const submit = async () => {
    setCreating(true);
    try { await onCreate({ name, minecraftVersion: version, loader, loaderVersion }); }
    finally { setCreating(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal create-modal">
    <div className="modal-head"><div><span className="panel-kicker">NEW INSTANCE</span><h2>Создать профиль</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
    <label className="form-label">Название профиля<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Мой Minecraft" maxLength={32} /></label>
    <div className="form-two"><label className="form-label">Версия Minecraft<select value={version} onChange={(event) => setVersion(event.target.value)}>{versions.map((item) => <option key={item.id} value={item.id}>{item.id} {item.type === 'snapshot' ? '· SNAPSHOT' : ''}</option>)}</select></label><label className="form-label">Загрузчик<select value={loader} onChange={(event) => setLoader(event.target.value as LoaderType)}>{Object.entries(loaderNames).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label></div>
    {loader !== 'vanilla' && <label className="form-label">Версия {loaderNames[loader]}{loadingLoaders ? <span className="inline-loading"><Loader2 size={13} className="spin" /> Загрузка доступных версий…</span> : <select value={loaderVersion} onChange={(event) => setLoaderVersion(event.target.value)}><option value="">Автоматически выбрать совместимую</option>{options.map((item) => <option key={item} value={item}>{item}</option>)}</select>}</label>}
    {loader !== 'vanilla' && !loadingLoaders && !loaderSupported && <div className="loader-unavailable-note"><AlertTriangle size={15}/><span>{loaderOptions.errors?.[loader] ? `Не удалось получить каталог ${loaderNames[loader]}: ${loaderOptions.errors[loader]}. Проверь интернет и повтори запрос.` : `${loaderNames[loader]} не опубликовал совместимых сборок для Minecraft ${version}. Выбери другую версию игры или Vanilla.`}</span></div>}
    {loader !== 'vanilla' && loaderSupported && !loadingLoaders && <div className="loader-versions-note"><CheckCircle2 size={14}/> Найдено совместимых сборок: {options.length}. Показан полный опубликованный список версий, включая предварительные.{loaderOptions.errors?.[loader] ? ` Предупреждение каталога: ${loaderOptions.errors[loader]}` : ''}</div>}
    <div className="modal-tip"><ShieldCheck size={16} /><span>Будет создана отдельная папка экземпляра. Игровые файлы будут загружены официально при первой установке.</span></div>
    <div className="modal-actions"><button className="outline-button" onClick={onClose}>ОТМЕНА</button><button className="primary-button" onClick={submit} disabled={creating || !version || !loaderSupported || loadingLoaders}><Plus size={16} /> {creating ? 'СОЗДАНИЕ…' : 'СОЗДАТЬ ПРОФИЛЬ'}</button></div>
  </div></div>;
}

function CatalogModal({ type, profile, onClose, onInstalled }: { type: 'mod' | 'modpack'; profile: Profile; onClose: () => void; onInstalled: (message: string) => void }) {
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [categories, setCategories] = useState<Array<{ name: string; header?: string; icon?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<'relevance' | 'downloads' | 'follows' | 'updated' | 'newest'>('downloads');
  const [category, setCategory] = useState('');
  const [total, setTotal] = useState(0);
  const pageSize = 24;
  const page = Math.floor(offset / pageSize) + 1;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const search = useCallback(async (searchText: string) => {
    setLoading(true); setMessage('');
    try {
      const response = await window.nebula.searchModrinth(searchText, type, profile.id, { offset, sort, category, limit: pageSize });
      setProjects(response.hits);
      setTotal(response.total_hits);
      if (response.hits.length === 0) setMessage('Для текущих фильтров проектов не найдено. Измени категорию или поисковый запрос.');
    } catch (error: any) { setMessage(error.message || 'Ошибка Modrinth API'); }
    finally { setLoading(false); }
  }, [type, profile.id, offset, sort, category]);

  useEffect(() => { window.nebula.getModrinthCategories(type).then((items) => setCategories(items.filter((item) => !['fabric', 'forge', 'neoforge', 'quilt', 'liteloader'].includes(item.name)))).catch(() => setCategories([])); }, [type]);
  useEffect(() => { void search(query); }, [search]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    if (offset !== 0) setOffset(0);
    else void search(query);
  };

  const installProject = async (project: Project) => {
    setInstalling(project.project_id); setMessage('');
    try {
      if (type === 'mod') {
        const count = await window.nebula.installModrinthMod(project.project_id, profile.id);
        onInstalled(`Установлено: ${project.title} (+${Math.max(0, count - 1)} обязательных зависимостей)`);
      } else {
        const result = await window.nebula.installModrinthPack(project.project_id, profile.id);
        onInstalled(`Сборка «${result.packName}» установлена · ${result.modsInstalled} модов`);
      }
    } catch (error: any) { setMessage(error.message || 'Не удалось установить проект'); }
    finally { setInstalling(null); }
  };

  const changeCategory = (value: string) => { setCategory(value); setOffset(0); };
  return <div className="modal-backdrop catalog-backdrop vanta-catalog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="modal catalog-modal vanta-catalog">
      <div className="catalog-topline"><span>VANTA DISCOVERY / MODRINTH</span><button className="icon-button" onClick={onClose}><X size={18} /></button></div>
      <div className="catalog-title"><div><span className="panel-kicker">{profile.minecraftVersion} · {loaderNames[profile.loader]} · {type === 'mod' ? 'MOD LIBRARY' : 'MODPACK LIBRARY'}</span><h2>{type === 'mod' ? 'Исследуй моды' : 'Открой новые сборки'}<span>.</span></h2><p>Каталог Modrinth · {total.toLocaleString('ru-RU')} проектов в текущей выборке</p></div><div className="catalog-orb"><Sparkles size={28} /></div></div>
      <form className="catalog-search vanta-search" onSubmit={submitSearch}><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={type === 'mod' ? 'Название, автор или ключевые слова…' : 'Найти модпак…'} /><button type="submit">НАЙТИ <ArrowUpRight size={14} /></button></form>
      <div className="catalog-toolbar"><div className="catalog-category-list"><button className={!category ? 'active' : ''} onClick={() => changeCategory('')}>Все проекты</button>{categories.map((item) => <button key={item.name} className={category === item.name ? 'active' : ''} onClick={() => changeCategory(item.name)}>{item.name.replaceAll('-', ' ')}</button>)}</div><label className="catalog-sort"><SlidersHorizontal size={15} /><select value={sort} onChange={(event) => { setSort(event.target.value as typeof sort); setOffset(0); }}><option value="downloads">Популярные</option><option value="follows">По подписчикам</option><option value="updated">Недавно обновлённые</option><option value="newest">Новые</option><option value="relevance">По релевантности</option></select></label></div>
      <div className="catalog-profile-filter"><span><Check size={13} /> Minecraft {profile.minecraftVersion}</span>{type === 'mod' && <span><Check size={13} /> {loaderNames[profile.loader]}</span>}<span><Sparkles size={13} /> Только совместимые версии</span><span className="catalog-page-count">Страница {page} / {totalPages}</span></div>
      <div className="catalog-results vanta-project-grid">
        {loading ? <div className="catalog-loading"><Loader2 size={28} className="spin" /><span>Сканируем каталог Modrinth…</span><small>Загружаем страницу {page}</small></div> : projects.map((project, index) => <article className="vanta-project-card" key={project.project_id} style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}>
          <div className="vanta-project-head">{project.icon_url ? <img loading="lazy" decoding="async" src={project.icon_url} alt="" /> : <div className="project-placeholder"><Puzzle size={21} /></div>}<div className="vanta-project-ident"><b>{project.title}</b><span>{project.slug}</span></div><button className="project-open" title="Открыть страницу Modrinth" onClick={() => void window.nebula.openModrinthProject(type, project.slug)}><ArrowUpRight size={16} /></button></div>
          <p>{project.description || 'Описание проекта не добавлено.'}</p>
          <div className="vanta-project-tags">{(project.categories || []).slice(0, 3).map((tag) => <span key={tag}>{tag.replaceAll('-', ' ')}</span>)}</div>
          <div className="vanta-project-footer"><div><b>{project.downloads.toLocaleString('ru-RU')}</b><span>ЗАГРУЗОК</span></div><div><b>{project.follows.toLocaleString('ru-RU')}</b><span>ПОДПИСЧИКОВ</span></div><button className="install-small" disabled={!!installing} onClick={() => void installProject(project)}>{installing === project.project_id ? <Loader2 size={15} className="spin" /> : <Download size={15} />}{installing === project.project_id ? 'УСТАНОВКА' : 'УСТАНОВИТЬ'}</button></div>
        </article>)}
        {!loading && projects.length === 0 && <div className="catalog-empty"><Search size={28} /><p>{message || 'Нет результатов'}</p></div>}
      </div>
      {message && projects.length > 0 && <div className="catalog-inline-error">{message}</div>}
      <div className="catalog-footer vanta-catalog-footer"><span>Показываем {projects.length ? offset + 1 : 0}–{Math.min(offset + projects.length, total)} из {total.toLocaleString('ru-RU')}</span><div><button disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - pageSize))}><ChevronLeft size={16} /> НАЗАД</button><button disabled={offset + pageSize >= total || loading} onClick={() => setOffset(offset + pageSize)}>ДАЛЕЕ <ChevronRight size={16} /></button></div><button onClick={onClose}>ЗАКРЫТЬ</button></div>
    </div>
  </div>;
}

function SplashScreen({ version }: { version: string }) {
  return <div className="vanta-splash"><div className="splash-background" /><div className="splash-center"><div className="splash-logo"><img src={vantaLogo} alt="Vanta" /></div><div className="splash-wordmark">VANTA</div><div className="splash-subtitle">YOUR WORLD. YOUR RULES.</div><div className="splash-loader"><i /></div><div className="splash-version">STABLE RELEASE · {version}</div></div><div className="splash-footer"><span>INITIALIZING GAME ENVIRONMENT</span><span>MOJANG / MODRINTH / VANTA CORE</span></div></div>;
}

function FriendsView({ state, profiles, onAdd, onRemove, onJoin, onManualPort, notify }: {
  state: FriendsState | null;
  profiles: Profile[];
  onAdd: (code: string, name: string) => Promise<void>;
  onRemove: (friend: FriendPresence) => void;
  onJoin: (friend: FriendPresence) => void;
  onManualPort: (port: number | null) => Promise<void>;
  notify: (message: string, error?: boolean) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [portText, setPortText] = useState('');
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState(false);
  const formatCode = (raw: string) => `VANTA-${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}`;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAdding(true);
    try { await onAdd(code, name); setCode(''); setName(''); }
    catch (error: any) { notify(error?.message || 'Не удалось добавить друга', true); }
    finally { setAdding(false); }
  };
  const shareManualPort = async () => {
    const port = Number(portText);
    setSharing(true);
    try { await onManualPort(port); notify(`LAN-мир опубликован на порту ${port}`); }
    catch (error: any) { notify(error?.message || 'Не удалось опубликовать мир', true); }
    finally { setSharing(false); }
  };
  const sortedFriends = [...(state?.friends || [])].sort((a, b) => Number(b.hosting) - Number(a.hosting) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return <section className="section-layout friends-layout">
    <div className="friends-heading"><div><span className="panel-kicker">VANTA SOCIAL / LOCAL NETWORK</span><h1>Твоя <em>команда</em>.</h1><p>Добавляй друзей по коду и подключайся к их LAN-мирам, когда они открыты.</p></div><div className={`friends-network-badge ${state?.lanDiscovery ? 'online' : 'offline'}`}>{state?.lanDiscovery ? <Wifi size={17}/> : <WifiOff size={17}/>}<span>{state?.lanDiscovery ? 'LAN ОБНАРУЖЕНИЕ АКТИВНО' : 'LAN ОБНАРУЖЕНИЕ'}</span></div></div>
    <div className="friends-top-grid">
      <article className="friends-code-card"><div className="friends-card-icon"><Users size={20}/></div><span className="panel-kicker">ТВОЙ VANTA FRIEND CODE</span><b>{state?.myCode || 'ГЕНЕРАЦИЯ…'}</b><p>Отправь этот код другу. Он сможет добавить тебя в свой список.</p><button onClick={() => { if (!state?.myCode) return; void navigator.clipboard.writeText(state.myCode).then(() => notify('Код друга скопирован')).catch(() => notify('Не удалось скопировать код', true)); }} disabled={!state?.myCode}><Copy size={14}/> СКОПИРОВАТЬ КОД</button></article>
      <form className="friends-add-card" onSubmit={submit}><div className="friends-add-title"><div className="friends-card-icon"><UserPlus size={20}/></div><div><span className="panel-kicker">НОВЫЙ КОНТАКТ</span><h3>Добавить друга</h3></div></div><label>КОД ДРУГА<input value={code} onChange={(event) => setCode(event.target.value)} placeholder="VANTA-XXXX-XXXX-XXXX" maxLength={24} required/></label><label>ИМЯ ДЛЯ СПИСКА<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Например, Alex" maxLength={32} required/></label><button type="submit" disabled={adding || !code.trim() || !name.trim()}><UserPlus size={14}/>{adding ? 'ДОБАВЛЯЕМ…' : 'ДОБАВИТЬ В ДРУЗЬЯ'}</button></form>
    </div>
    <div className="friends-section-head"><div><span className="panel-kicker">FRIEND LIST</span><h2>Друзья <small>{sortedFriends.length}</small></h2></div><span className="friends-discovery-status">{state?.discoveryMessage || 'Запуск локального обнаружения…'}</span></div>
    {sortedFriends.length === 0 ? <div className="friends-empty"><div className="friends-empty-orb"><Users size={31}/></div><h3>Здесь пока тихо</h3><p>Добавь друга по VANTA-коду. Когда вы оба будете в одной сети Wi-Fi, его статус появится автоматически.</p></div> : <div className="friends-list">{sortedFriends.map((friend) => {
      const matching = profiles.find((profile) => profile.installed && profile.minecraftVersion === friend.minecraftVersion && profile.loader === friend.loader && (profile.loaderVersion || '') === (friend.loaderVersion || ''));
      return <article className={`friend-card ${friend.hosting ? 'hosting' : ''}`} key={friend.code}><div className="friend-avatar">{friend.name.slice(0,1).toUpperCase()}</div><div className="friend-main"><b>{friend.name}</b><span className="friend-code-label">{formatCode(friend.code)}</span><div className="friend-status-row"><i className={friend.online ? 'friend-online-dot' : 'friend-offline-dot'}/><span>{friend.hosting ? `Открыл LAN-мир · ${friend.worldName || 'Minecraft'}` : friend.online ? 'В сети VANTA' : 'Не в сети'}</span>{friend.online && friend.minecraftVersion && <em>{friend.minecraftVersion} · {friend.loader?.toUpperCase()}{friend.loaderVersion ? ` ${friend.loaderVersion}` : ''}</em>}</div></div><div className="friend-actions">{friend.hosting ? <button className="friend-join" disabled={!matching} title={!matching ? `Нужен установленный профиль ${friend.minecraftVersion} · ${friend.loader}` : 'Подключиться к миру друга'} onClick={() => onJoin(friend)}><Link2 size={15}/> ПОДКЛЮЧИТЬСЯ</button> : <span className="friend-waiting">{friend.online ? 'МИР НЕ ОТКРЫТ' : 'ОЖИДАНИЕ'}</span>}<button className="friend-remove" title="Удалить друга" onClick={() => onRemove(friend)}><Trash2 size={15}/></button></div></article>;
    })}</div>}
    <div className="friends-host-panel"><div className="friends-host-icon"><Wifi size={20}/></div><div className="friends-host-copy"><span className="panel-kicker">КАК ПОЗВАТЬ ДРУЗЕЙ</span><h3>Открой свой мир для локальной сети</h3><p>Запусти Minecraft через VANTA → зайди в одиночный мир → нажми Esc → «Открыть для сети». VANTA автоматически обнаружит порт и покажет друзьям кнопку подключения.</p></div><div className="friends-manual-port"><label>ПОРТ ВРУЧНУЮ<input type="number" min="1" max="65535" value={portText} onChange={(event) => setPortText(event.target.value)} placeholder="Напр. 51423"/></label><button disabled={sharing || !/^([1-9]\d{0,4})$/.test(portText) || Number(portText) > 65535} onClick={() => void shareManualPort()}>{sharing ? <Loader2 size={14} className="spin"/> : <Wifi size={14}/>} ПОДЕЛИТЬСЯ</button><button className="friends-stop-share" onClick={() => { setPortText(''); void onManualPort(null).then(() => notify('Ручная публикация выключена')).catch((error: any) => notify(error?.message || 'Не удалось выключить публикацию', true)); }}>СТОП</button></div></div>
    <div className="friends-note"><ShieldCheck size={15}/><span>VANTA обнаруживает друзей только внутри одной локальной сети (одна Wi-Fi-сеть или роутер). LAN-код не является паролем мира: Minecraft может быть доступен и другим устройствам в этой сети. Для подключения через интернет нужна отдельная защищённая relay-система.</span></div>
  </section>;
}

function UpdatesView({ state, onCheck, onDownload, onInstall, onConfigure }: { state: LauncherUpdateState | null; onCheck: () => void; onDownload: () => void; onInstall: () => void; onConfigure: () => void }) {
  const releaseNotes = [
    { version: '1.4.0', date: '22.11.2026', tag: 'STABLE RELEASE', items: ['Полный визуальный редизайн Full HD: обновлённая сетка, стеклянные панели, улучшенная типографика и контраст.', 'Стартовое окно Electron теперь 1600×900 с минимальным размером 1180×720 и корректной работой на Windows DPI 100%, 125% и 150%.', 'Герой главного экрана использует отдельный высокодетальный vanta-world.png, упакованный Vite как оптимизированный asset.', 'Канал обновлений переведён на стабильный latest: allowPrerelease=false, latest.yml и только стабильные GitHub Releases.', 'Публикация GitHub теперь требует чистую версию SemVer и создаёт обычный Release без флага Pre-Release.', 'Пути логотипа и панорамного изображения оставлены и проверены; существующие игровые функции и каталог профилей сохранены.'] },
    { version: '1.3.0-beta.2', date: '22.11.2026', tag: 'PRE-RELEASE', items: ['Текущая версия лаунчера во всех интерфейсных блоках берётся из app.getVersion() и package.json.', 'Состояние автообновления передаёт новую версию из info.version и список изменений из info.releaseNotes.', 'Новая версия и заметки релиза отображаются в баннере обновления, на кнопке скачивания и в карточке релиза.', 'Добавлен RELEASE_NOTES.md в корень проекта; версия package.json повышена до 1.3.0-beta.2.'] },
    { version: '1.3.0-beta.1', date: '22.11.2026', tag: 'PRE-RELEASE', items: ['Полный список доступных версий Fabric и NeoForge по официальным метаданным; совместимость проверяется для выбранной версии Minecraft.', 'Список Forge расширен через Maven metadata, а Vanilla продолжает получать все версии из Mojang manifest.', 'Добавлена вкладка «Друзья» с уникальным VANTA-кодом, добавлением контактов и статусом присутствия в одной локальной сети.', 'VANTA отслеживает собственный LAN-анонс Minecraft и показывает порт открытого мира; ручной ввод порта оставлен как запасной способ.', 'Подключение к другу запускает тот же установленный профиль и использует Quick Play для Minecraft 1.20+ или legacy server args для старых версий.', 'Профили, миры, моды и настройки сохраняются в прежнем каталоге пользовательских данных.'] },
    { version: '1.2.0-beta.2', date: '20.11.2026', tag: 'PRE-RELEASE', items: ['Добавлена настройка канала автообновлений через панель разработчика.', 'Поддержаны GitHub Releases и Generic HTTPS; добавлена проверка доступности репозитория и beta.yml.', 'Добавлен сценарий публикации Pre-Release, автопроверка при запуске и каждые 10 минут.', 'Сохранена совместимость со старым HTTPS-конфигом update-feed.json.'] },
    { version: '1.2.0-beta.1', date: '20.11.2026', tag: 'PRE-RELEASE', items: ['Полностью обновлена визуальная система: Aurora Glass, кинематографическая панорама и адаптивные карточки.', 'Добавлены мягкие звуки интерфейса с выключателем и синтезом через Web Audio API.', 'Создана локальная панель разработчика с логином, хешированием пароля scrypt и автоматической блокировкой попыток входа.', 'Добавлены системная телеметрия, просмотр последних строк журнала и локальное обслуживание.', 'Сохранена совместимость с прежним каталогом профилей Minecraft.'] },
    { version: '1.1.0-beta.2', date: '20.11.2026', tag: 'PRE-RELEASE', items: ['Исправлена сборка Windows: типы заметок автообновления теперь учитывают null в releaseNotes.'] },
    { version: '1.1.0-beta.1', date: '20.11.2026', tag: 'PRE-RELEASE', items: ['Полностью новая визуальная система Vanta: новый фирменный знак, палитра и типографика.', 'Новая стартовая анимация и плавные переходы между разделами.', 'Каталог Modrinth превращён в постраничную библиотеку с категориями, сортировкой и поиском.', 'Добавлен экран истории изменений и блок доступного обновления.', 'Обновлён установщик: ярлык на рабочем столе и в меню «Пуск».', 'Новая панорамная иллюстрация высокого разрешения вместо старой пиксельной графики.'] },
    { version: '1.0.3', date: '20.11.2026', tag: 'STABLE BASE', items: ['Починка сборки и диагностика Minecraft / Forge.', 'Сохранение launcher_profiles.json перед установкой Forge.', 'Проверка Java, библиотек, ресурсов и контрольных сумм файлов.'] }
  ];
  return <div className="section-layout updates-layout">
    <div className="updates-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> RELEASE CHANNEL</span><h1>ЖУРНАЛ <em>ОБНОВЛЕНИЙ</em><span className="title-dot">.</span></h1><p>История изменений VANTA Launcher и управление стабильными обновлениями клиента.</p></div><span className="prerelease-stamp">STABLE RELEASE<br /><b>{state?.currentVersion || '…'}</b></span></div>
    <section className="update-control-panel"><div className="update-control-icon"><RefreshCw size={22} /></div><div className="update-control-copy"><span className="panel-kicker">LIVE UPDATE CHANNEL</span><h3>{state?.status === 'available' ? `Доступна версия ${state.availableVersion}` : state?.status === 'downloaded' ? 'Обновление готово к установке' : 'Проверка обновлений'}</h3><p>{state?.message || 'Получаем состояние канала обновлений…'}</p>{state?.status === 'downloading' && <div className="update-download-track"><i style={{ width: `${state.percent}%` }} /></div>}</div><div className="update-control-actions">{state?.status === 'available' ? <button className="update-main-button" onClick={onDownload}><CloudDownload size={16} /> СКАЧАТЬ {state.availableVersion}</button> : state?.status === 'downloaded' ? <button className="update-main-button" onClick={onInstall}><RefreshCw size={16} /> ПЕРЕЗАПУСТИТЬ</button> : <button className="update-main-button" onClick={onCheck} disabled={state?.status === 'checking' || state?.status === 'downloading'}><RefreshCw size={16} className={state?.status === 'checking' ? 'spin' : ''} /> ПРОВЕРИТЬ</button>}</div></section>
    {state?.feedConfigured && <div className="update-feed-connected"><span className="connected-dot"/> ИСТОЧНИК: <b>{state.feedProvider === 'github' ? 'GITHUB RELEASES' : 'HTTPS FEED'}</b>{state.feedName && <code>{state.feedName}</code>}<span>· Автопроверка каждые 10 минут</span></div>}
    {!state?.feedConfigured && <div className="update-setup-note"><AlertTriangle size={17} /><div><b>Автообновления ещё не подключены.</b><span>Подключи публичный GitHub Releases или HTTPS-каталог в панели разработчика. Адрес больше не нужно прописывать в исходном коде.</span><button className="update-config-link" onClick={onConfigure}>ОТКРЫТЬ НАСТРОЙКИ КАНАЛА <ArrowUpRight size={13}/></button></div></div>}
    {state && (state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded') && <section className="release-card remote-release-card"><div className="release-card-head"><div><span>LATEST RELEASE NOTES</span><h3>Новая версия {state.availableVersion}</h3></div></div><ul>{state.notes.length > 0 ? state.notes.map((item, index) => <li key={`${index}-${item}`}><Check size={14} />{item}</li>) : <li><Check size={14} />В опубликованном релизе пока нет списка изменений.</li>}</ul></section>}
    <div className="release-list">{releaseNotes.map((release) => <article className="release-card" key={release.version}><div className="release-timeline"><i /></div><div className="release-main"><div className="release-card-head"><div><span>{release.tag}</span><h3>Vanta Launcher {release.version}</h3></div><time>{release.date}</time></div><ul>{release.items.map((item) => <li key={item}><Check size={14} />{item}</li>)}</ul></div></article>)}</div>
  </div>;
}
