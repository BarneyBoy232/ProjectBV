// The projectBV Tools registry. Each entry is a self-contained add-on tool that
// plugs into the dashboard. Add a new tool by dropping a folder under tools/ and
// appending it here — the Tools page and nav pick it up automatically.
import RemotePage from './remote/RemotePage'
import MonitorPage from './monitor/MonitorPage'
import LoggerPage from './logger/LoggerPage'
import FilesPage from './files/FilesPage'
import { remoteLogoSvg, monitorLogoSvg, loggerLogoSvg, filesLogoSvg } from '../ui'

export const TOOLS = [
  {
    id: 'remote',
    name: 'Remote',
    tagline: 'See and control any fleet device — live screen, apps, tabs, on-screen messages, reboot.',
    icon: remoteLogoSvg,
    component: RemotePage,
  },
  {
    id: 'monitor',
    name: 'Task Manager',
    tagline: 'Any fleet device, live — processes, performance, services, startup, users.',
    icon: monitorLogoSvg,
    component: MonitorPage,
  },
  {
    id: 'logger',
    name: 'Logger',
    tagline: 'Watch any fleet device live — screen, speaker output, microphone, and every key and click.',
    icon: loggerLogoSvg,
    component: LoggerPage,
  },
  {
    id: 'files',
    name: 'Files',
    tagline: 'Browse any fleet device — download, upload, move, rename, and rescue files remotely.',
    icon: filesLogoSvg,
    component: FilesPage,
  },
]
