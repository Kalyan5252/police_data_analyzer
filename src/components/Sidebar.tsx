'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  UploadCloud,
  MessageSquareText,
  ShieldAlert,
  FolderKanban,
  Plus,
  Loader2,
  Clock3,
  Pencil,
  Trash2,
  Check,
  X,
} from 'lucide-react';

type CaseItem = {
  caseId: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  lastMessagePreview: string;
};

const navigation = [
  { name: 'Analyze', href: '/analyze', icon: MessageSquareText },
  { name: 'Data Loaders', href: '/data-loaders', icon: UploadCloud },
];

function formatUpdatedAt(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  const [cases, setCases] = useState<CaseItem[]>([]);
  const [isLoadingCases, setIsLoadingCases] = useState(false);
  const [isCreatingCase, setIsCreatingCase] = useState(false);
  const [editingCaseId, setEditingCaseId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [busyCaseId, setBusyCaseId] = useState<string | null>(null);

  const activeCaseId = searchParams.get('case');

  const loadCases = async () => {
    setIsLoadingCases(true);
    try {
      const res = await fetch('/api/cases', { cache: 'no-store' });
      const data = await res.json();
      if (res.ok && data.success && Array.isArray(data.cases)) {
        setCases(data.cases as CaseItem[]);
      }
    } finally {
      setIsLoadingCases(false);
    }
  };

  useEffect(() => {
    void loadCases();
  }, []);

  useEffect(() => {
    const handler = () => {
      void loadCases();
    };

    window.addEventListener('case-history-updated', handler);
    return () => window.removeEventListener('case-history-updated', handler);
  }, []);

  const createCase = async () => {
    setIsCreatingCase(true);
    try {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (res.ok && data.success && data.case?.caseId) {
        await loadCases();
        router.push(`/analyze?case=${encodeURIComponent(data.case.caseId as string)}`);
      }
    } finally {
      setIsCreatingCase(false);
    }
  };

  const startRename = (caseItem: CaseItem) => {
    setEditingCaseId(caseItem.caseId);
    setEditingTitle(caseItem.title || 'Untitled Case');
  };

  const cancelRename = () => {
    setEditingCaseId(null);
    setEditingTitle('');
  };

  const saveRename = async (caseId: string) => {
    const title = editingTitle.trim();
    if (!title) return;

    setBusyCaseId(caseId);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });

      if (res.ok) {
        cancelRename();
        await loadCases();
        window.dispatchEvent(new Event('case-history-updated'));
      }
    } finally {
      setBusyCaseId(null);
    }
  };

  const deleteCase = async (caseItem: CaseItem) => {
    const ok = window.confirm(
      `Delete conversation "${caseItem.title}"? This will remove all chat messages in this case.`,
    );
    if (!ok) return;

    setBusyCaseId(caseItem.caseId);
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseItem.caseId)}`, {
        method: 'DELETE',
      });

      if (!res.ok) return;

      await loadCases();
      window.dispatchEvent(new Event('case-history-updated'));

      const remaining = cases.filter((c) => c.caseId !== caseItem.caseId);
      if (activeCaseId === caseItem.caseId) {
        if (remaining.length > 0) {
          router.push(`/analyze?case=${encodeURIComponent(remaining[0].caseId)}`);
        } else {
          await createCase();
        }
      }
    } finally {
      setBusyCaseId(null);
      if (editingCaseId === caseItem.caseId) {
        cancelRename();
      }
    }
  };

  const caseItems = useMemo(() => cases.slice(0, 30), [cases]);

  return (
    <div className="flex flex-col w-72 bg-slate-50 border-r border-brand-light/30 h-screen fixed top-0 left-0 overflow-y-auto">
      <div className="flex items-center gap-3 p-6 border-b border-brand-light/30 bg-white">
        <ShieldAlert className="w-8 h-8 text-brand-dark" />
        <div>
          <h1 className="text-xl font-bold text-brand-dark tracking-tight">IPDR Platform</h1>
          <p className="text-xs text-slate-500 font-medium">Investigation Tool</p>
        </div>
      </div>

      <nav className="p-4 space-y-1">
        {navigation.map((item) => {
          const isActive =
            pathname === item.href ||
            (pathname === '/' && item.href === '/analyze') ||
            (pathname === '/analyze' && item.href === '/analyze');

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

      <div className="mx-4 border-t border-brand-light/35" />

      <section className="flex-1 p-4 pt-3">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderKanban className="w-4 h-4 text-brand-dark" />
            <h2 className="text-xs font-bold uppercase tracking-wider text-brand-dark/85">
              Case Histories
            </h2>
          </div>
          <button
            type="button"
            onClick={() => void createCase()}
            disabled={isCreatingCase}
            className="inline-flex items-center gap-1 rounded-md border border-brand-light/40 bg-white px-2 py-1 text-[11px] font-semibold text-brand-dark hover:bg-brand-light/10 disabled:opacity-60"
          >
            {isCreatingCase ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}
            New Case
          </button>
        </div>

        {isLoadingCases ? (
          <div className="rounded-lg border border-brand-light/30 bg-white p-3 text-xs text-slate-500 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading case histories...
          </div>
        ) : caseItems.length === 0 ? (
          <div className="rounded-lg border border-dashed border-brand-light/40 bg-white p-3 text-xs text-slate-500">
            No case histories yet. Create one to start tracking investigation chats.
          </div>
        ) : (
          <div className="space-y-2">
            {caseItems.map((caseItem) => {
              const isActive = pathname === '/analyze' && activeCaseId === caseItem.caseId;
              const isEditing = editingCaseId === caseItem.caseId;
              const isBusy = busyCaseId === caseItem.caseId;

              return (
                <div
                  key={caseItem.caseId}
                  className={`group rounded-lg border px-3 py-2 transition-all ${
                    isActive
                      ? 'border-brand-dark/60 bg-brand-light/20 shadow-sm'
                      : 'border-brand-light/30 bg-white hover:border-brand-light/60 hover:bg-brand-light/10'
                  }`}
                >
                  {isEditing ? (
                    <div className="space-y-2">
                      <input
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        className="w-full rounded border border-brand-light/50 px-2 py-1 text-xs text-slate-700 outline-none focus:border-brand-dark"
                        maxLength={120}
                      />
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={cancelRename}
                          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600 hover:bg-slate-100"
                        >
                          <X className="w-3 h-3" />
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={isBusy || !editingTitle.trim()}
                          onClick={() => void saveRename(caseItem.caseId)}
                          className="inline-flex items-center gap-1 rounded border border-brand-light/40 bg-brand-dark text-white px-2 py-1 text-[10px] font-semibold hover:bg-brand-dark/90 disabled:opacity-60"
                        >
                          {isBusy ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Check className="w-3 h-3" />
                          )}
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <Link href={`/analyze?case=${encodeURIComponent(caseItem.caseId)}`}>
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-[12px] font-semibold text-brand-dark leading-tight line-clamp-2">
                            {caseItem.title || 'Untitled Case'}
                          </p>
                          <span className="inline-flex items-center gap-1 text-[10px] text-slate-500 shrink-0">
                            <Clock3 className="w-3 h-3" />
                            {formatUpdatedAt(caseItem.updatedAt)}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-slate-500 line-clamp-2">
                          {caseItem.lastMessagePreview || 'No messages yet.'}
                        </p>
                      </Link>

                      <div className="mt-2 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => startRename(caseItem)}
                          className="inline-flex items-center justify-center rounded p-1.5 text-slate-500 hover:bg-brand-light/25 hover:text-brand-dark disabled:opacity-60"
                          title="Rename conversation"
                          aria-label="Rename conversation"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void deleteCase(caseItem)}
                          className="inline-flex items-center justify-center rounded p-1.5 text-rose-600 hover:bg-rose-100 disabled:opacity-60"
                          title="Delete conversation"
                          aria-label="Delete conversation"
                        >
                          {isBusy ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Trash2 className="w-3 h-3" />
                          )}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="p-4 border-t border-brand-light/30 bg-slate-50/70">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-xs font-semibold text-slate-500">System Online</span>
        </div>
      </div>
    </div>
  );
}
