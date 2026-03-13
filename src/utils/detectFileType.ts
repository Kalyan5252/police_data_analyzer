/**
 * Detects the type of investigation data file based on its column headers.
 * Mirrors the backend Python detect_file_type logic.
 */
export type FileType = 'SDR' | 'BANK' | 'CDR' | 'IPDR' | 'TD' | 'UNKNOWN';

export function detectFileType(columns: string[]): FileType {
  const cols = new Set(
    columns.map((c) => c.toUpperCase().trim().replace(/ /g, '_')),
  );

  console.log('Normalized columns:', cols);

  // SDR detection
  const sdrRequired = new Set([
    'PHONE_NUMBER',
    'ALTERNATIVE_MOBILE_NO',
    'SUBSCIRBER_NAME',
    'GUARDIAN_NAME',
    'ADDRESS',
    'DATE_OF_ACTIVATION',
    'TYPE_OF_CONNECTION',
    'SERVICE_PROVIDER',
    'PHONE5',
  ]);
  if (isSubset(sdrRequired, cols)) return 'SDR';

  // BANK detection
  const bankRequired = new Set([
    'AC_NO',
    'TRAN_DATE',
    'TRAN_ID',
    'DR_AMT',
    'CR_AMT',
    'BALANCE',
  ]);
  if (isSubset(bankRequired, cols)) return 'BANK';

  // CDR / TD detection (first pass — shorter column set)
  const cdrBase = new Set([
    'A_PARTY',
    'B_PARTY',
    'CALL_TYPE',
    'IMEI_A',
    'IMSI_A',
  ]);
  if (isSubset(cdrBase, cols)) {
    if (cols.has('ROAMING_A')) return 'TD';
    return 'CDR';
  }

  // IPDR detection (uses intersection, not subset)
  const ipdrIndicators = [
    'SOURCE_IP_ADDRESS',
    'TRANSLATED_IP_ADDRESS',
    'DESTINATION_IP_ADDRESS',
    'SESSION_DURATION',
  ];
  if (ipdrIndicators.some((col) => cols.has(col))) return 'IPDR';

  // TD detection (second pass — full column set)
  const tdFull = new Set([
    'A_PARTY',
    'B_PARTY',
    'DATE',
    'TIME',
    'DURATION',
    'CALL_TYPE',
    'FIRST_CELL_ID_A',
    'LAST_CELL_ID_A',
    'IMEI_A',
    'IMSI_A',
    'FIRST_CELL_ID_A_ADDRESS',
    'ROAMING_A',
    'LATITUDE',
    'LONGITUDE',
  ]);
  if (isSubset(tdFull, cols)) return 'TD';

  return 'UNKNOWN';
}

/** Check if every element of `a` is present in `b` */
function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
