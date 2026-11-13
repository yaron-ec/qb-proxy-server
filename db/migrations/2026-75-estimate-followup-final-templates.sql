-- =====================================================================
-- 2026-75-estimate-followup-final-templates.sql — the business owner's
-- final-approved copy for the six-email estimate follow-up sequence
-- (explicit approval given verbatim; this is a direct transcription, not
-- Claude-authored wording — same "one-time approval record" precedent as
-- the original seed in 2026-70-estimate-followup-sequence.sql and
-- lib/smsTemplates.js's own header).
--
-- Each template_key gets a NEW version (2), flipped to is_active=TRUE;
-- the prior version-1 row (from 2026-70) is flipped to is_active=FALSE
-- and otherwise left untouched — mirrors
-- lib/estimateFollowupTemplates.js#saveTemplateVersion's own "never
-- mutate an existing row" transaction shape exactly, just expressed as
-- migration SQL instead of an application call, since this content must
-- ship through the same deploy pipeline as every other change here.
-- Confirmed via a read-only production check immediately before writing
-- this migration: no other migration has touched
-- estimate_followup_templates since 2026-70, so every template_key's
-- current max version is exactly 1 — version 2 is correct and cannot
-- collide with the (template_key, version) unique constraint.
--
-- Day 1/3/5/8/11/14 schedule, {{first_name}}/{{sales_rep_name}} tokens,
-- and the render-time compliance footer are all completely unchanged —
-- this migration only ever touches body_html/subject/version/is_active.
-- =====================================================================

UPDATE estimate_followup_templates
   SET is_active = FALSE
 WHERE is_active = TRUE
   AND template_key IN ('day1', 'day3', 'day5', 'day8', 'day11', 'day14');

INSERT INTO estimate_followup_templates (template_key, version, subject, body_html, is_active, created_by)
VALUES
  ('day1', 2, 'Just checking in on your estimate',
   '<p>Hi {{first_name}},</p>' ||
   '<p>Just wanted to make sure you received the estimate for your project.</p>' ||
   '<p>If you have any questions or would like to go over the details together, I''m always happy to help.</p>' ||
   '<p>Talk soon,<br>{{sales_rep_name}}<br>EC Construction Group</p>',
   TRUE, 'system:migration-2026-75'),
  ('day3', 2, 'Any questions about your project?',
   '<p>Hi {{first_name}},</p>' ||
   '<p>Hope you''ve had a chance to look over the estimate. I know there''s a lot to consider when planning a remodeling project.</p>' ||
   '<p>If anything is unclear or you''d like to discuss the scope of work, just reply to this email. I''d be happy to walk you through it.</p>' ||
   '<p>Best,<br>{{sales_rep_name}}<br>EC Construction Group</p>',
   TRUE, 'system:migration-2026-75'),
  ('day5', 2, 'What to expect when working with us',
   '<p>Hi {{first_name}},</p>' ||
   '<p>Choosing the right contractor is a big decision, and we want you to feel confident every step of the way.</p>' ||
   '<p>If you''d like to know more about our process, communication, or what to expect during construction, I''m happy to answer any questions.</p>' ||
   '<p>Best,<br>{{sales_rep_name}}<br>EC Construction Group</p>',
   TRUE, 'system:migration-2026-75'),
  ('day8', 2, 'Checking in on your project plans',
   '<p>Hi {{first_name}},</p>' ||
   '<p>Just checking in to see how you''re feeling about the project and whether you''ve had a chance to think about the next steps.</p>' ||
   '<p>If there''s anything holding you back or something you''d like to discuss, please let me know. No pressure at all.</p>' ||
   '<p>Best,<br>{{sales_rep_name}}<br>EC Construction Group</p>',
   TRUE, 'system:migration-2026-75'),
  ('day11', 2, 'Would a quick call be helpful?',
   '<p>Hi {{first_name}},</p>' ||
   '<p>Sometimes it''s easier to go over everything in a quick conversation rather than back and forth over email.</p>' ||
   '<p>If you''d like, we can schedule a short call to answer any remaining questions about your estimate or project.</p>' ||
   '<p>Best,<br>{{sales_rep_name}}<br>EC Construction Group</p>',
   TRUE, 'system:migration-2026-75'),
  ('day14', 2, 'One last check-in about your project',
   '<p>Hi {{first_name}},</p>' ||
   '<p>I wanted to reach out one last time regarding your estimate.</p>' ||
   '<p>If you''re still considering the project, we''d love the opportunity to work with you. And if the timing isn''t right, that''s completely understandable.</p>' ||
   '<p>Whenever you''re ready or have any questions, feel free to reach out.</p>' ||
   '<p>All the best,<br>{{sales_rep_name}}<br>EC Construction Group</p>',
   TRUE, 'system:migration-2026-75')
ON CONFLICT (template_key, version) DO NOTHING;
