/**
 * ContactActions
 *
 * Reusable row of Call, SMS, Email action buttons.
 *
 * On mobile the buttons are plain <a> tags with tel:/sms:/mailto: hrefs so
 * the browser hands them directly to the native dialer/messenger/mail app
 * without any JavaScript popup that Safari/Chrome would block.
 *
 * Props:
 *   phone  — raw phone string (optional)
 *   email  — email address (optional)
 *   size   — 'sm' (default, for cards) | 'md' (for detail panels) | 'lg' (mobile header)
 *   labels — show text labels next to icons (default false)
 */
import { useState } from 'react';
import { Phone, MessageSquare, Mail } from 'lucide-react';
import { formatPhone } from '@/lib/formatters';
import { composeEmail, isMobileDevice } from '@/lib/contactActions';

function toDialable(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return digits ? `+${digits}` : '';
}

export default function ContactActions({ phone, email, size = 'sm', labels = false }) {
  const [fallbackMsg, setFallbackMsg] = useState(null);

  if (!phone && !email) return null;

  const dialable = toDialable(phone);

  // Size-specific classes
  const iconSize = size === 'lg' ? 'w-5 h-5' : size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5';
  const btnBase = size === 'lg'
    ? 'inline-flex items-center justify-center gap-2 flex-1 py-2.5 px-3 rounded-xl text-sm font-semibold border-2 transition-colors active:scale-95'
    : size === 'md'
    ? 'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors active:scale-95 btn-compact'
    : 'inline-flex items-center gap-1 px-2 py-1.5 rounded-md text-[11px] font-semibold border transition-colors active:scale-95 btn-compact';

  const showFallback = (type) => {
    const msgs = { call: 'Unable to open phone app.', sms: 'Unable to open message app.', email: 'Unable to open email app.' };
    setFallbackMsg(msgs[type]);
    setTimeout(() => setFallbackMsg(null), 3000);
  };

  const handleEmailClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent?.stopImmediatePropagation();
    if (!email) return;
    if (isMobileDevice()) {
      window.location.href = `mailto:${email}`;
    } else {
      const w = window.open(
        `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}`,
        '_blank', 'noopener'
      );
      if (!w) showFallback('email');
    }
  };

  const containerClass = size === 'lg'
    ? 'flex items-center gap-2 w-full'
    : 'flex items-center gap-1.5 flex-wrap';

  return (
    <div>
      <div className={containerClass}>
        {phone && dialable && (
          <>
            {/* Call — plain <a href="tel:"> so mobile browser hands off natively */}
            <a
              href={`tel:${dialable}`}
              title={`Call ${formatPhone(phone)}`}
              onClick={e => e.stopPropagation()}
              className={`${btnBase} bg-green-50 border-green-200 text-green-700 hover:bg-green-100 hover:border-green-400`}
            >
              <Phone className={iconSize} />
              {(labels || size === 'lg') && <span>Call</span>}
            </a>

            {/* SMS — plain <a href="sms:"> */}
            <a
              href={`sms:${dialable}`}
              title={`Text ${formatPhone(phone)}`}
              onClick={e => e.stopPropagation()}
              className={`${btnBase} bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100 hover:border-blue-400`}
            >
              <MessageSquare className={iconSize} />
              {(labels || size === 'lg') && <span>Text</span>}
            </a>
          </>
        )}

        {email && (
          <a
            href={`mailto:${email}`}
            onClick={handleEmailClick}
            title={`Email ${email}`}
            className={`${btnBase} bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100 hover:border-amber-400`}
          >
            <Mail className={iconSize} />
            {(labels || size === 'lg') && <span>Email</span>}
          </a>
        )}
      </div>

      {fallbackMsg && (
        <p className="text-[11px] text-red-500 mt-1">{fallbackMsg}</p>
      )}
    </div>
  );
}