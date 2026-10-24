-- Demo session with 24 default prompts. Run after the migration.
-- Code: DEMO23. Created without an owner (created_by is null).
insert into sessions (code, name, duration_seconds, winners_count)
values ('DEMO23', 'Demo session', 600, 3)
on conflict (code) do nothing;

insert into session_prompts (session_id, text, position)
select s.id, p.text, p.position
from sessions s,
(values
  (0, 'Has a pet'),
  (1, 'Speaks 3+ languages'),
  (2, 'Has run a marathon'),
  (3, 'Plays a musical instrument'),
  (4, 'Has visited 10+ countries'),
  (5, 'Is a morning person'),
  (6, 'Drinks more than 3 cups of coffee a day'),
  (7, 'Prefers tea over coffee'),
  (8, 'Has a garden or lots of houseplants'),
  (9, 'Loves to cook'),
  (10, 'Has been on live TV or radio'),
  (11, 'Can juggle'),
  (12, 'Has a hidden talent'),
  (13, 'Reads more than 20 books a year'),
  (14, 'Has lived in another country'),
  (15, 'Loves hiking'),
  (16, 'Plays video games'),
  (17, 'Plays board games regularly'),
  (18, 'Has met a celebrity'),
  (19, 'Has a favorite podcast to recommend'),
  (20, 'Knows how to salsa dance'),
  (21, 'Has gone skydiving or bungee jumping'),
  (22, 'Collects something unusual'),
  (23, 'Has a black belt or martial arts training')
) as p(position, text)
where s.code = 'DEMO23'
on conflict (session_id, position) do nothing;
