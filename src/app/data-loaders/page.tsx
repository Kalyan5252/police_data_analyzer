'use client';

import { useState, useCallback } from 'react';
import {
  UploadCloud,
  FileText,
  AlertCircle,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  XCircle,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { detectFileType, type FileType } from '@/utils/detectFileType';

const API_BASE = 'http://127.0.0.1:8000/api/v1/loaders';

/** Maps detected file types to their backend route segments */
const ROUTE_MAP: Record<FileType, string | null> = {
  CDR: 'cdr',
  IPDR: 'ipdr',
  TD: 'tower',
  SDR: 'sdr',
  BANK: 'bank',
  UNKNOWN: null,
};

type DetectionResult = {
  type: FileType;
  columns: string[];
};

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

export default function DataLoadersPage() {
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<UploadStatus>('idle');
  const [uploadMessage, setUploadMessage] = useState('');
  const [accountNumber, setAccountNumber] = useState('');

  const ACCEPTED_TYPES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
  ];
  const ACCEPTED_EXTENSIONS = ['.pdf', '.xlsx', '.xls'];

  const isAccepted = (f: File) => {
    const ext = f.name.substring(f.name.lastIndexOf('.')).toLowerCase();
    return ACCEPTED_TYPES.includes(f.type) || ACCEPTED_EXTENSIONS.includes(ext);
  };

  const isPdf = (f: File) => {
    const ext = f.name.substring(f.name.lastIndexOf('.')).toLowerCase();
    return f.type === 'application/pdf' || ext === '.pdf';
  };

  const analyzeFile = useCallback(async (f: File) => {
    setIsAnalyzing(true);
    setDetection(null);
    setUploadStatus('idle');
    setUploadMessage('');

    if (isPdf(f)) {
      console.log('[DataLoaders] PDF detected — will route to /kyc');
      setDetection({ type: 'UNKNOWN', columns: [] });
      setIsAnalyzing(false);
      return;
    }

    try {
      const buffer = await f.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const jsonData = XLSX.utils.sheet_to_json<string[]>(worksheet, {
        header: 1,
      });

      if (jsonData.length === 0) {
        console.warn('[DataLoaders] Sheet is empty — no columns found.');
        setDetection({ type: 'UNKNOWN', columns: [] });
        setIsAnalyzing(false);
        return;
      }

      const columns = (jsonData[0] as string[]).map(String);
      console.log('[DataLoaders] Extracted columns:', columns);

      const fileType = detectFileType(columns);
      console.log('[DataLoaders] Detected file type:', fileType);

      setDetection({ type: fileType, columns });
    } catch (err) {
      console.error('[DataLoaders] Failed to parse file:', err);
      setDetection({ type: 'UNKNOWN', columns: [] });
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  const processFile = (f: File) => {
    if (!isAccepted(f)) {
      alert('Please upload a PDF or Excel (.xlsx) file.');
      return;
    }
    setFile(f);
    setUploadStatus('idle');
    setUploadMessage('');
    setAccountNumber('');
    analyzeFile(f);
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const handleUpload = async () => {
    if (!file || !detection) return;

    // Determine the correct route
    let route: string;
    if (isPdf(file)) {
      route = 'kyc';
    } else {
      const mapped = ROUTE_MAP[detection.type];
      if (!mapped) {
        setUploadStatus('error');
        setUploadMessage(
          'Could not determine the file type. Please verify the file has correct column headers.',
        );
        return;
      }
      route = mapped;
    }

    // Bank type requires account_number
    if (detection.type === 'BANK' && !accountNumber.trim()) {
      setUploadStatus('error');
      setUploadMessage('Account number is required for Bank records.');
      return;
    }

    const url = `${API_BASE}/${route}`;
    const formData = new FormData();
    formData.append('file', file);

    if (detection.type === 'BANK') {
      formData.append('account_number', accountNumber.trim());
    }

    console.log(`[DataLoaders] Uploading to ${url}`);
    setUploadStatus('uploading');
    setUploadMessage('');

    try {
      const res = await fetch(url, {
        method: 'POST',
        body: formData,
      });

      if (res.ok) {
        const data = await res.json();
        console.log('[DataLoaders] Upload success:', data);
        setUploadStatus('success');
        setUploadMessage(
          `Successfully uploaded to /${route}. ${data.message || ''}`,
        );
      } else {
        const errText = await res.text();
        console.error('[DataLoaders] Upload failed:', res.status, errText);
        setUploadStatus('error');
        setUploadMessage(`Server responded with ${res.status}: ${errText}`);
      }
    } catch (err) {
      console.error('[DataLoaders] Network error:', err);
      setUploadStatus('error');
      setUploadMessage(
        'Network error — could not reach the backend. Is the server running on port 8000?',
      );
    }
  };

  // --- UI Helpers ---

  const typeBadgeColor: Record<FileType, string> = {
    SDR: 'bg-violet-100 text-violet-700 border-violet-200',
    BANK: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    CDR: 'bg-sky-100 text-sky-700 border-sky-200',
    IPDR: 'bg-amber-100 text-amber-700 border-amber-200',
    TD: 'bg-rose-100 text-rose-700 border-rose-200',
    UNKNOWN: 'bg-slate-100 text-slate-600 border-slate-200',
  };

  const typeLabel: Record<FileType, string> = {
    SDR: 'Subscriber Detail Record',
    BANK: 'Bank Transaction Record',
    CDR: 'Call Detail Record',
    IPDR: 'IP Detail Record',
    TD: 'Tower Dump Record',
    UNKNOWN: 'Unknown Format',
  };

  const routeLabel = () => {
    if (!file || !detection) return '';
    if (isPdf(file)) return '/api/v1/loaders/kyc';
    const mapped = ROUTE_MAP[detection.type];
    return mapped ? `/api/v1/loaders/${mapped}` : '—';
  };

  const canUpload =
    file &&
    detection &&
    !isAnalyzing &&
    uploadStatus !== 'uploading' &&
    (isPdf(file) || detection.type !== 'UNKNOWN') &&
    (detection.type !== 'BANK' || accountNumber.trim().length > 0);

  return (
    <div className="p-8 max-w-4xl mx-auto w-full">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-brand-dark mb-2">
          Data Loaders
        </h1>
        <p className="text-slate-500">
          Upload investigation documents and IPDR records (PDF or Excel) for
          processing.
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-brand-light/20 p-8">
        {/* Drop Zone */}
        <div
          className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors flex flex-col items-center justify-center ${
            dragActive
              ? 'border-brand-dark bg-brand-light/5'
              : 'border-brand-light/50 bg-slate-50 hover:bg-slate-100'
          }`}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
        >
          <input
            type="file"
            accept=".pdf,.xlsx,.xls"
            onChange={handleChange}
            className="hidden"
            id="file-upload"
          />
          <label
            htmlFor="file-upload"
            className="cursor-pointer flex flex-col items-center w-full"
          >
            <UploadCloud
              className={`w-12 h-12 mb-4 ${
                dragActive ? 'text-brand-dark' : 'text-brand-light'
              }`}
            />
            <h3 className="text-lg font-medium text-slate-800 mb-1">
              {dragActive ? 'Drop file here' : 'Drag & Drop your file here'}
            </h3>
            <p className="text-sm text-slate-500 mb-6">
              Supports <strong>.pdf</strong> and <strong>.xlsx</strong> files
            </p>
            <span className="px-4 py-2 bg-brand-dark text-white text-sm font-medium rounded-md shadow hover:bg-brand-dark/90 transition-colors">
              Select File
            </span>
          </label>
        </div>

        {/* Selected File Card */}
        {file && (
          <div className="mt-6 p-4 border border-brand-light/30 rounded-lg bg-slate-50">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-brand-light/20 flex items-center justify-center">
                  {isPdf(file) ? (
                    <FileText className="w-5 h-5 text-brand-dark" />
                  ) : (
                    <FileSpreadsheet className="w-5 h-5 text-brand-dark" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-800 truncate max-w-xs">
                    {file.name}
                  </p>
                  <p className="text-xs text-slate-500">
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
              </div>
              <button
                onClick={handleUpload}
                disabled={!canUpload}
                className="px-4 py-2 bg-brand-dark text-white text-sm font-medium rounded-md shadow hover:bg-brand-dark/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                {uploadStatus === 'uploading' ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <UploadCloud className="w-4 h-4" />
                    Process Document
                  </>
                )}
              </button>
            </div>

            {/* Detection Result */}
            {isAnalyzing && (
              <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="w-4 h-4 animate-spin text-brand-dark" />
                Analyzing file structure…
              </div>
            )}

            {detection && !isAnalyzing && (
              <div className="mt-4 p-4 bg-white rounded-lg border border-brand-light/20">
                <div className="flex items-center gap-3 mb-3">
                  <CheckCircle2 className="w-5 h-5 text-brand-dark" />
                  <span className="text-sm font-semibold text-slate-700">
                    Detection Result
                  </span>
                  <span
                    className={`ml-auto px-3 py-1 text-xs font-bold rounded-full border ${
                      typeBadgeColor[detection.type]
                    }`}
                  >
                    {detection.type}
                  </span>
                </div>
                <p className="text-sm text-slate-600 mb-1">
                  {isPdf(file)
                    ? 'PDF detected — will be routed to KYC endpoint.'
                    : `Identified as ${typeLabel[detection.type]}.`}
                </p>
                <p className="text-xs text-slate-400 font-mono mb-3">
                  Endpoint →{' '}
                  <span className="text-brand-dark font-semibold">
                    {routeLabel()}
                  </span>
                </p>

                {/* Bank account number field */}
                {detection.type === 'BANK' && (
                  <div className="mt-3 mb-3 p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                    <label
                      htmlFor="account-number"
                      className="block text-sm font-semibold text-emerald-800 mb-1.5"
                    >
                      Account Number <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="account-number"
                      type="text"
                      value={accountNumber}
                      onChange={(e) => setAccountNumber(e.target.value)}
                      placeholder="Enter the account number for this bank record"
                      className="w-full px-3 py-2 rounded-md border border-emerald-300 bg-white text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-dark focus:border-brand-dark"
                    />
                  </div>
                )}

                {detection.columns.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-brand-dark font-medium hover:underline">
                      View extracted columns ({detection.columns.length})
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {detection.columns.map((col, i) => (
                        <span
                          key={i}
                          className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded border border-slate-200 font-mono"
                        >
                          {col}
                        </span>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}

            {/* Upload Status Banner */}
            {uploadStatus === 'success' && (
              <div className="mt-4 flex items-center gap-3 p-3 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-lg text-sm font-medium">
                <CheckCircle2 className="w-5 h-5 shrink-0" />
                {uploadMessage}
              </div>
            )}
            {uploadStatus === 'error' && (
              <div className="mt-4 flex items-center gap-3 p-3 bg-red-50 text-red-800 border border-red-200 rounded-lg text-sm font-medium">
                <XCircle className="w-5 h-5 shrink-0" />
                {uploadMessage}
              </div>
            )}
          </div>
        )}

        {/* Notice */}
        <div className="mt-8 flex items-start gap-3 p-4 bg-brand-light/5 rounded-lg border border-brand-light/20">
          <AlertCircle className="w-5 h-5 text-brand-dark mt-0.5 shrink-0" />
          <div className="text-sm text-slate-600">
            <strong className="block text-brand-dark mb-1">
              Important Notice:
            </strong>
            Uploaded documents are processed securely and sent to the extraction
            service. Large IPDR files might take up to a few minutes to be fully
            indexed.
          </div>
        </div>
      </div>
    </div>
  );
}
