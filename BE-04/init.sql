-- create the table
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  done BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- insert default tasks into the table
INSERT INTO tasks (title, done) VALUES 
  ('Write project report', FALSE),
  ('Review code', FALSE),
  ('Finish Stage 2', TRUE)
ON CONFLICT DO NOTHING;
