/**
 * Complete world currency list for FlowOps.
 * Used by the searchable CurrencySelector component in company creation
 * and company settings. FlowOps launches internationally — every world
 * currency is included.
 */

export interface Currency {
  code: string
  name: string
  symbol: string
  flag: string
}

export const CURRENCIES: Currency[] = [
  // Most common (shown at top of list)
  { code: 'PKR', name: 'Pakistani Rupee', symbol: '₨', flag: '🇵🇰' },
  { code: 'USD', name: 'US Dollar', symbol: '$', flag: '🇺🇸' },
  { code: 'GBP', name: 'British Pound', symbol: '£', flag: '🇬🇧' },
  { code: 'EUR', name: 'Euro', symbol: '€', flag: '🇪🇺' },
  { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', flag: '🇦🇪' },
  { code: 'SAR', name: 'Saudi Riyal', symbol: '﷼', flag: '🇸🇦' },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', flag: '🇨🇦' },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', flag: '🇦🇺' },
  // --- all other world currencies alphabetically ---
  { code: 'AFN', name: 'Afghan Afghani', symbol: '؋', flag: '🇦🇫' },
  { code: 'ALL', name: 'Albanian Lek', symbol: 'L', flag: '🇦🇱' },
  { code: 'AMD', name: 'Armenian Dram', symbol: '֏', flag: '🇦🇲' },
  { code: 'ANG', name: 'Netherlands Antillean Guilder', symbol: 'ƒ', flag: '🇨🇼' },
  { code: 'AOA', name: 'Angolan Kwanza', symbol: 'Kz', flag: '🇦🇴' },
  { code: 'ARS', name: 'Argentine Peso', symbol: '$', flag: '🇦🇷' },
  { code: 'AWG', name: 'Aruban Florin', symbol: 'ƒ', flag: '🇦🇼' },
  { code: 'AZN', name: 'Azerbaijani Manat', symbol: '₼', flag: '🇦🇿' },
  { code: 'BAM', name: 'Bosnia-Herzegovina Mark', symbol: 'KM', flag: '🇧🇦' },
  { code: 'BBD', name: 'Barbadian Dollar', symbol: '$', flag: '🇧🇧' },
  { code: 'BDT', name: 'Bangladeshi Taka', symbol: '৳', flag: '🇧🇩' },
  { code: 'BGN', name: 'Bulgarian Lev', symbol: 'лв', flag: '🇧🇬' },
  { code: 'BHD', name: 'Bahraini Dinar', symbol: '.د.ب', flag: '🇧🇭' },
  { code: 'BIF', name: 'Burundian Franc', symbol: 'Fr', flag: '🇧🇮' },
  { code: 'BMD', name: 'Bermudan Dollar', symbol: '$', flag: '🇧🇲' },
  { code: 'BND', name: 'Brunei Dollar', symbol: '$', flag: '🇧🇳' },
  { code: 'BOB', name: 'Bolivian Boliviano', symbol: 'Bs.', flag: '🇧🇴' },
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', flag: '🇧🇷' },
  { code: 'BSD', name: 'Bahamian Dollar', symbol: '$', flag: '🇧🇸' },
  { code: 'BTN', name: 'Bhutanese Ngultrum', symbol: 'Nu', flag: '🇧🇹' },
  { code: 'BWP', name: 'Botswanan Pula', symbol: 'P', flag: '🇧🇼' },
  { code: 'BYN', name: 'Belarusian Ruble', symbol: 'Br', flag: '🇧🇾' },
  { code: 'BZD', name: 'Belize Dollar', symbol: '$', flag: '🇧🇿' },
  { code: 'CDF', name: 'Congolese Franc', symbol: 'Fr', flag: '🇨🇩' },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'Fr', flag: '🇨🇭' },
  { code: 'CLP', name: 'Chilean Peso', symbol: '$', flag: '🇨🇱' },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', flag: '🇨🇳' },
  { code: 'COP', name: 'Colombian Peso', symbol: '$', flag: '🇨🇴' },
  { code: 'CRC', name: 'Costa Rican Colón', symbol: '₡', flag: '🇨🇷' },
  { code: 'CUP', name: 'Cuban Peso', symbol: '$', flag: '🇨🇺' },
  { code: 'CVE', name: 'Cape Verdean Escudo', symbol: '$', flag: '🇨🇻' },
  { code: 'CZK', name: 'Czech Koruna', symbol: 'Kč', flag: '🇨🇿' },
  { code: 'DJF', name: 'Djiboutian Franc', symbol: 'Fr', flag: '🇩🇯' },
  { code: 'DKK', name: 'Danish Krone', symbol: 'kr', flag: '🇩🇰' },
  { code: 'DOP', name: 'Dominican Peso', symbol: '$', flag: '🇩🇴' },
  { code: 'DZD', name: 'Algerian Dinar', symbol: 'د.ج', flag: '🇩🇿' },
  { code: 'EGP', name: 'Egyptian Pound', symbol: '£', flag: '🇪🇬' },
  { code: 'ERN', name: 'Eritrean Nakfa', symbol: 'Nfk', flag: '🇪🇷' },
  { code: 'ETB', name: 'Ethiopian Birr', symbol: 'Br', flag: '🇪🇹' },
  { code: 'FJD', name: 'Fijian Dollar', symbol: '$', flag: '🇫🇯' },
  { code: 'FKP', name: 'Falkland Islands Pound', symbol: '£', flag: '🇫🇰' },
  { code: 'GEL', name: 'Georgian Lari', symbol: '₾', flag: '🇬🇪' },
  { code: 'GHS', name: 'Ghanaian Cedi', symbol: '₵', flag: '🇬🇭' },
  { code: 'GIP', name: 'Gibraltar Pound', symbol: '£', flag: '🇬🇮' },
  { code: 'GMD', name: 'Gambian Dalasi', symbol: 'D', flag: '🇬🇲' },
  { code: 'GNF', name: 'Guinean Franc', symbol: 'Fr', flag: '🇬🇳' },
  { code: 'GTQ', name: 'Guatemalan Quetzal', symbol: 'Q', flag: '🇬🇹' },
  { code: 'GYD', name: 'Guyanaese Dollar', symbol: '$', flag: '🇬🇾' },
  { code: 'HKD', name: 'Hong Kong Dollar', symbol: '$', flag: '🇭🇰' },
  { code: 'HNL', name: 'Honduran Lempira', symbol: 'L', flag: '🇭🇳' },
  { code: 'HRK', name: 'Croatian Kuna', symbol: 'kn', flag: '🇭🇷' },
  { code: 'HTG', name: 'Haitian Gourde', symbol: 'G', flag: '🇭🇹' },
  { code: 'HUF', name: 'Hungarian Forint', symbol: 'Ft', flag: '🇭🇺' },
  { code: 'IDR', name: 'Indonesian Rupiah', symbol: 'Rp', flag: '🇮🇩' },
  { code: 'ILS', name: 'Israeli New Shekel', symbol: '₪', flag: '🇮🇱' },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', flag: '🇮🇳' },
  { code: 'IQD', name: 'Iraqi Dinar', symbol: 'ع.د', flag: '🇮🇶' },
  { code: 'IRR', name: 'Iranian Rial', symbol: '﷼', flag: '🇮🇷' },
  { code: 'ISK', name: 'Icelandic Króna', symbol: 'kr', flag: '🇮🇸' },
  { code: 'JMD', name: 'Jamaican Dollar', symbol: '$', flag: '🇯🇲' },
  { code: 'JOD', name: 'Jordanian Dinar', symbol: 'د.ا', flag: '🇯🇴' },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', flag: '🇯🇵' },
  { code: 'KES', name: 'Kenyan Shilling', symbol: 'Ksh', flag: '🇰🇪' },
  { code: 'KGS', name: 'Kyrgystani Som', symbol: 'с', flag: '🇰🇬' },
  { code: 'KHR', name: 'Cambodian Riel', symbol: '៛', flag: '🇰🇭' },
  { code: 'KMF', name: 'Comorian Franc', symbol: 'Fr', flag: '🇰🇲' },
  { code: 'KPW', name: 'North Korean Won', symbol: '₩', flag: '🇰🇵' },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩', flag: '🇰🇷' },
  { code: 'KWD', name: 'Kuwaiti Dinar', symbol: 'د.ك', flag: '🇰🇼' },
  { code: 'KYD', name: 'Cayman Islands Dollar', symbol: '$', flag: '🇰🇾' },
  { code: 'KZT', name: 'Kazakhstani Tenge', symbol: '₸', flag: '🇰🇿' },
  { code: 'LAK', name: 'Laotian Kip', symbol: '₭', flag: '🇱🇦' },
  { code: 'LBP', name: 'Lebanese Pound', symbol: '£', flag: '🇱🇧' },
  { code: 'LKR', name: 'Sri Lankan Rupee', symbol: '₨', flag: '🇱🇰' },
  { code: 'LRD', name: 'Liberian Dollar', symbol: '$', flag: '🇱🇷' },
  { code: 'LSL', name: 'Lesotho Loti', symbol: 'L', flag: '🇱🇸' },
  { code: 'LYD', name: 'Libyan Dinar', symbol: 'ل.د', flag: '🇱🇾' },
  { code: 'MAD', name: 'Moroccan Dirham', symbol: 'د.م.', flag: '🇲🇦' },
  { code: 'MDL', name: 'Moldovan Leu', symbol: 'L', flag: '🇲🇩' },
  { code: 'MGA', name: 'Malagasy Ariary', symbol: 'Ar', flag: '🇲🇬' },
  { code: 'MKD', name: 'Macedonian Denar', symbol: 'ден', flag: '🇲🇰' },
  { code: 'MMK', name: 'Myanmar Kyat', symbol: 'K', flag: '🇲🇲' },
  { code: 'MNT', name: 'Mongolian Tugrik', symbol: '₮', flag: '🇲🇳' },
  { code: 'MOP', name: 'Macanese Pataca', symbol: 'P', flag: '🇲🇴' },
  { code: 'MRU', name: 'Mauritanian Ouguiya', symbol: 'UM', flag: '🇲🇷' },
  { code: 'MUR', name: 'Mauritian Rupee', symbol: '₨', flag: '🇲🇺' },
  { code: 'MVR', name: 'Maldivian Rufiyaa', symbol: 'Rf', flag: '🇲🇻' },
  { code: 'MWK', name: 'Malawian Kwacha', symbol: 'MK', flag: '🇲🇼' },
  { code: 'MXN', name: 'Mexican Peso', symbol: '$', flag: '🇲🇽' },
  { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM', flag: '🇲🇾' },
  { code: 'MZN', name: 'Mozambican Metical', symbol: 'MT', flag: '🇲🇿' },
  { code: 'NAD', name: 'Namibian Dollar', symbol: '$', flag: '🇳🇦' },
  { code: 'NGN', name: 'Nigerian Naira', symbol: '₦', flag: '🇳🇬' },
  { code: 'NIO', name: 'Nicaraguan Córdoba', symbol: 'C$', flag: '🇳🇮' },
  { code: 'NOK', name: 'Norwegian Krone', symbol: 'kr', flag: '🇳🇴' },
  { code: 'NPR', name: 'Nepalese Rupee', symbol: '₨', flag: '🇳🇵' },
  { code: 'NZD', name: 'New Zealand Dollar', symbol: '$', flag: '🇳🇿' },
  { code: 'OMR', name: 'Omani Rial', symbol: '﷼', flag: '🇴🇲' },
  { code: 'PAB', name: 'Panamanian Balboa', symbol: 'B/.', flag: '🇵🇦' },
  { code: 'PEN', name: 'Peruvian Sol', symbol: 'S/.', flag: '🇵🇪' },
  { code: 'PGK', name: 'Papua New Guinean Kina', symbol: 'K', flag: '🇵🇬' },
  { code: 'PHP', name: 'Philippine Peso', symbol: '₱', flag: '🇵🇭' },
  { code: 'PLN', name: 'Polish Zloty', symbol: 'zł', flag: '🇵🇱' },
  { code: 'PYG', name: 'Paraguayan Guarani', symbol: '₲', flag: '🇵🇾' },
  { code: 'QAR', name: 'Qatari Rial', symbol: '﷼', flag: '🇶🇦' },
  { code: 'RON', name: 'Romanian Leu', symbol: 'lei', flag: '🇷🇴' },
  { code: 'RSD', name: 'Serbian Dinar', symbol: 'din', flag: '🇷🇸' },
  { code: 'RUB', name: 'Russian Ruble', symbol: '₽', flag: '🇷🇺' },
  { code: 'RWF', name: 'Rwandan Franc', symbol: 'Fr', flag: '🇷🇼' },
  { code: 'SEK', name: 'Swedish Krona', symbol: 'kr', flag: '🇸🇪' },
  { code: 'SGD', name: 'Singapore Dollar', symbol: '$', flag: '🇸🇬' },
  { code: 'SHP', name: 'Saint Helena Pound', symbol: '£', flag: '🇸🇭' },
  { code: 'SLL', name: 'Sierra Leonean Leone', symbol: 'Le', flag: '🇸🇱' },
  { code: 'SOS', name: 'Somali Shilling', symbol: 'Sh', flag: '🇸🇴' },
  { code: 'SRD', name: 'Surinamese Dollar', symbol: '$', flag: '🇸🇷' },
  { code: 'STN', name: 'São Tomé & Príncipe Dobra', symbol: 'Db', flag: '🇸🇹' },
  { code: 'SVC', name: 'Salvadoran Colón', symbol: '₡', flag: '🇸🇻' },
  { code: 'SYP', name: 'Syrian Pound', symbol: '£', flag: '🇸🇾' },
  { code: 'SZL', name: 'Swazi Lilangeni', symbol: 'L', flag: '🇸🇿' },
  { code: 'THB', name: 'Thai Baht', symbol: '฿', flag: '🇹🇭' },
  { code: 'TJS', name: 'Tajikistani Somoni', symbol: 'SM', flag: '🇹🇯' },
  { code: 'TMT', name: 'Turkmenistani Manat', symbol: 'T', flag: '🇹🇲' },
  { code: 'TND', name: 'Tunisian Dinar', symbol: 'د.ت', flag: '🇹🇳' },
  { code: 'TOP', name: 'Tongan Paʻanga', symbol: 'T$', flag: '🇹🇴' },
  { code: 'TRY', name: 'Turkish Lira', symbol: '₺', flag: '🇹🇷' },
  { code: 'TTD', name: 'Trinidad & Tobago Dollar', symbol: '$', flag: '🇹🇹' },
  { code: 'TWD', name: 'New Taiwan Dollar', symbol: '$', flag: '🇹🇼' },
  { code: 'TZS', name: 'Tanzanian Shilling', symbol: 'Sh', flag: '🇹🇿' },
  { code: 'UAH', name: 'Ukrainian Hryvnia', symbol: '₴', flag: '🇺🇦' },
  { code: 'UGX', name: 'Ugandan Shilling', symbol: 'Sh', flag: '🇺🇬' },
  { code: 'UYU', name: 'Uruguayan Peso', symbol: '$', flag: '🇺🇾' },
  { code: 'UZS', name: 'Uzbekistani Som', symbol: "so'm", flag: '🇺🇿' },
  { code: 'VES', name: 'Venezuelan Bolívar', symbol: 'Bs', flag: '🇻🇪' },
  { code: 'VND', name: 'Vietnamese Dong', symbol: '₫', flag: '🇻🇳' },
  { code: 'VUV', name: 'Vanuatu Vatu', symbol: 'Vt', flag: '🇻🇺' },
  { code: 'WST', name: 'Samoan Tala', symbol: 'T', flag: '🇼🇸' },
  { code: 'XAF', name: 'Central African CFA Franc', symbol: 'Fr', flag: '🇨🇲' },
  { code: 'XCD', name: 'East Caribbean Dollar', symbol: '$', flag: '🇦🇬' },
  { code: 'XOF', name: 'West African CFA Franc', symbol: 'Fr', flag: '🇧🇯' },
  { code: 'YER', name: 'Yemeni Rial', symbol: '﷼', flag: '🇾🇪' },
  { code: 'ZAR', name: 'South African Rand', symbol: 'R', flag: '🇿🇦' },
  { code: 'ZMW', name: 'Zambian Kwacha', symbol: 'ZK', flag: '🇿🇲' },
  { code: 'ZWL', name: 'Zimbabwean Dollar', symbol: '$', flag: '🇿🇼' },
]

/** Currency codes shown at the top of the selector before the full list. */
export const POPULAR_CURRENCIES = [
  'PKR',
  'USD',
  'GBP',
  'EUR',
  'AED',
  'SAR',
  'CAD',
  'AUD',
]

const CURRENCY_MAP = new Map(CURRENCIES.map((c) => [c.code, c]))

/** Lookup a currency by its 3-letter code. Returns undefined if not found. */
export function getCurrencyByCode(code: string): Currency | undefined {
  return CURRENCY_MAP.get(code.toUpperCase())
}

/** Format a currency for display: "🇵🇰 PKR — Pakistani Rupee" */
export function formatCurrencyLabel(currency: Currency): string {
  return `${currency.flag} ${currency.code} — ${currency.name}`
}

/** Format a currency code for display, falling back gracefully. */
export function formatCurrencyCode(code: string): string {
  const c = getCurrencyByCode(code)
  return c ? formatCurrencyLabel(c) : code
}
