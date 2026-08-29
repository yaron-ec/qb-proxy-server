/**
 * Email Templates for CRM
 */

export const EMAIL_TEMPLATES = {
  appointment_confirmation: {
    name: "Appointment Confirmation",
    subject: "Your Appointment with {company_name}",
    body: `Hi {lead_name},

Thank you for scheduling an appointment with us! We're looking forward to meeting with you.

Appointment Details:
Date: {appointment_date}
Time: {appointment_time}
Location: {location}

If you need to reschedule or have any questions, please don't hesitate to contact us.

Best regards,
{owner_name}
{owner_email}
{company_name}`,
  },

  appointment_reminder: {
    name: "Appointment Reminder",
    subject: "Reminder: Your Appointment Tomorrow",
    body: `Hi {lead_name},

Just a friendly reminder about your appointment with us tomorrow!

Appointment Details:
Date: {appointment_date}
Time: {appointment_time}
Location: {location}

We look forward to seeing you. If you have any questions or need to reschedule, please let us know.

Best regards,
{owner_name}
{owner_email}
{company_name}`,
  },

  follow_up: {
    name: "Follow-up",
    subject: "Following Up on {project_type}",
    body: `Hi {lead_name},

I wanted to follow up on your project for {project_type}. Do you have any questions or would you like to schedule a time to discuss your project in more detail?

I'm here to help and would love to hear from you.

Best regards,
{owner_name}
{owner_email}
{company_name}`,
  },

  estimate_sent: {
    name: "Estimate Sent",
    subject: "Your {company_name} Estimate",
    body: `Hi {lead_name},

Thank you for considering us for your {project_type} project. Please find attached your detailed estimate.

If you have any questions about the estimate or would like to discuss next steps, please don't hesitate to reach out.

We look forward to working with you!

Best regards,
{owner_name}
{owner_email}
{company_name}`,
  },

  thank_you: {
    name: "Thank You",
    subject: "Thank You for Choosing {company_name}",
    body: `Hi {lead_name},

Thank you for choosing us for your project! We're excited to get started and deliver excellent results for you.

If you have any questions during the process, please feel free to contact me anytime.

Best regards,
{owner_name}
{owner_email}
{company_name}`,
  },
};

export function getTemplateByKey(key) {
  return EMAIL_TEMPLATES[key] || null;
}

export function renderTemplate(template, variables) {
  let rendered = template.subject + "\n" + template.body;
  
  Object.entries(variables).forEach(([key, value]) => {
    const placeholder = `{${key}}`;
    rendered = rendered.replace(new RegExp(placeholder, 'g'), value || '');
  });

  // Split back into subject and body
  const [subject, ...bodyParts] = rendered.split('\n');
  return {
    subject: subject.trim(),
    body: bodyParts.join('\n').trim(),
  };
}