/**
 * Generate a Gmail compose URL with pre-filled recipient
 * Opens Gmail web compose in a new tab
 */
export const getGmailComposeUrl = (toEmail) => {
  if (!toEmail) return '#';
  return `https://mail.google.com/mail/u/0/#compose=new(to=${encodeURIComponent(toEmail)})`;
};

/**
 * Open Gmail compose in a new window/tab with pre-filled recipient
 */
export const openGmailCompose = (toEmail, e) => {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  if (toEmail) {
    window.open(getGmailComposeUrl(toEmail), '_blank');
  }
};