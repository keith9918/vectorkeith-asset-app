import { useEffect } from 'react';
import { FxLayer } from './components/FxLayer';
import { LoginGate } from './components/LoginGate';
import { Header, TabBar } from './components/Shell';
import { ToastHost } from './components/ui';
import { FULLSCREEN, useRoute } from './lib/hooks';
import { connect, useStore } from './lib/store';
import { AssetsPage } from './pages/AssetsPage';
import { ExplorePage } from './pages/ExplorePage';
import { ReportPage } from './pages/ReportPage';
import { ScreenPage } from './pages/ScreenPage';
import { SettingsPage } from './pages/SettingsPage';
import { SimInfoPage } from './pages/SimInfoPage';
import { SimPage } from './pages/SimPage';
import { ChainPage } from './pages/ChainPage';
import { ShareholdersPage } from './pages/ShareholdersPage';
import { StakingPage } from './pages/StakingPage';

const PAGES = {
  assets: AssetsPage,
  shareholders: ShareholdersPage,
  staking: StakingPage,
  sim: SimPage,
  chain: ChainPage,
  screen: ScreenPage,
  report: ReportPage,
  explore: ExplorePage,
  info: SimInfoPage, // 「信息」页改成 USVK 模拟盘的信息（原来的链上代币信息页 InfoPage.tsx 保留）
  settings: SettingsPage,
};

export function App() {
  const route = useRoute();
  const needLogin = useStore((s) => s.conn === 'login');
  useEffect(() => {
    connect();
  }, []);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route]);
  const Page = PAGES[route];
  if (needLogin) {
    return (
      <>
        <div className="bg-fx" aria-hidden />
        <LoginGate />
        <ToastHost />
      </>
    );
  }
  if (FULLSCREEN.includes(route)) {
    return (
      <>
        <Page />
        <FxLayer />
        <ToastHost />
      </>
    );
  }
  return (
    <>
      <div className="bg-fx" aria-hidden />
      <div className="app">
        <Header />
        <main className="main page-enter" key={route}>
          <Page />
        </main>
        <TabBar />
      </div>
      <FxLayer />
      <ToastHost />
    </>
  );
}
