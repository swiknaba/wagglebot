Sequel.migration do
  up do
    alter_table(:wagglebot_memories) do
      add_column :wake, TrueClass, null: false, default: false
      add_column :review_after, Date
      add_column :supersedes, String
    end

    alter_table(:wagglebot_memory_schema_metadata) do
      add_column :worker_state, :jsonb, null: false,
        default: Sequel.lit("'{\"operations\":{},\"sources\":{},\"reindex\":{\"pending\":[]}}'::jsonb")
    end
  end

  down do
    memories = self[:wagglebot_memories]
    metadata = self[:wagglebot_memory_schema_metadata]
    empty_worker_state = "'{\"operations\":{},\"sources\":{},\"reindex\":{\"pending\":[]}}'::jsonb"
    has_new_memory_data = memories.where(Sequel.lit("wake OR review_after IS NOT NULL OR supersedes IS NOT NULL")).count.positive?
    has_worker_state = metadata.exclude(Sequel.lit("worker_state = #{empty_worker_state}")).count.positive?
    if has_new_memory_data || has_worker_state
      raise Sequel::Error, "cannot roll back memory wire mapping with nonempty wake, review, supersedes, or worker_state data"
    end

    alter_table(:wagglebot_memory_schema_metadata) do
      drop_column :worker_state
    end
    alter_table(:wagglebot_memories) do
      drop_column :supersedes
      drop_column :review_after
      drop_column :wake
    end
  end
end
