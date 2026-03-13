'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { UploadCloud, MessageSquareText, ShieldAlert } from 'lucide-react';

const navigation = [
  { name: 'Analyze', href: '/analyze', icon: MessageSquareText },
  { name: 'Data Loaders', href: '/data-loaders', icon: UploadCloud },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="flex flex-col w-64 bg-slate-50 border-r border-brand-light/30 h-screen fixed top-0 left-0 overflow-y-auto">
      <div className="flex items-center gap-3 p-6 border-b border-brand-light/30">
        <ShieldAlert className="w-8 h-8 text-brand-dark" />
        <div>
          <h1 className="text-xl font-bold text-brand-dark tracking-tight">
            IPDR Platform
          </h1>
          <p className="text-xs text-slate-500 font-medium">
            Investigation Tool
          </p>
        </div>
      </div>
      <nav className="flex-1 p-4 space-y-1">
        {navigation.map((item) => {
          const isActive =
            pathname === item.href ||
            (pathname === '/' && item.href === '/analyze');
          return (
            <Link
              key={item.name}
              href={item.href}
              className={`group flex items-center gap-3 px-3 py-3 rounded-md text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-brand-dark text-white shadow-sm ring-1 ring-brand-dark/50'
                  : 'text-slate-600 hover:bg-brand-light/20 hover:text-brand-dark'
              }`}
            >
              <item.icon
                className={`w-5 h-5 ${isActive ? 'text-brand-light' : 'text-slate-400 group-hover:text-brand-dark'}`}
              />
              {item.name}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-brand-light/30 bg-slate-50/50">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
          <span className="text-xs font-semibold text-slate-500">
            System Online
          </span>
        </div>
      </div>
    </div>
  );
}
