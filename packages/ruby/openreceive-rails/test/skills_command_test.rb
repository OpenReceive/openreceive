# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require "fileutils"
require "rails/command"
require "rake"
require "openreceive/skills"

class OpenReceiveSkillsCommandTest < Minitest::Test
  def test_rails_command_and_rake_task_install_only_our_skills
    # Source-tree tests bypass Bundler; production resolves the installed gem.
    previous = Gem.loaded_specs["openreceive"]
    Gem.loaded_specs["openreceive"] = Gem::Specification.load(File.expand_path("../../openreceive/openreceive.gemspec", __dir__))
    Gem.loaded_specs["openreceive"].full_gem_path = File.expand_path("../../openreceive", __dir__)
    Dir.mktmpdir("openreceive-skills-") do |root|
      Dir.chdir(root) do
        [".agents/skills", ".claude/skills", File.join(root, "absolute skills")].each do |directory|
          target = File.expand_path(directory)
          FileUtils.mkdir_p(File.join(target, "other"))
          File.write(File.join(target, "other/SKILL.md"), "keep")
          args = directory == ".agents/skills" ? [] : ["--dir", directory]
          out, err = capture_io { Rails::Command.invoke("openreceive:skills", args) }
          assert_empty err
          %w[integrate-openreceive debug-openreceive-payment].each do |name|
            assert_includes File.read(File.join(target, name, "SKILL.md")), "name: #{name}"
            assert_includes out, File.join(target, name)
            File.write(File.join(target, name, "obsolete.md"), "old")
            File.write(File.join(target, name, "SKILL.md"), "old")
          end
          capture_io { Rails::Command.invoke("openreceive:skills", args) }
          %w[integrate-openreceive debug-openreceive-payment].each do |name|
            refute File.exist?(File.join(target, name, "obsolete.md"))
            assert_includes File.read(File.join(target, name, "SKILL.md")), "name: #{name}"
          end
          assert File.file?(File.join(target, "integrate-openreceive/references/rails.md"))
          assert_equal "keep", File.read(File.join(target, "other/SKILL.md"))
          assert_includes out, "--dir .claude/skills"
        end
        load File.expand_path("../lib/tasks/openreceive.rake", __dir__)
        capture_io { Rake::Task["openreceive:skills"].invoke("rake-skills") }
        assert File.file?("rake-skills/integrate-openreceive/SKILL.md")
      end
    end
  ensure
    if previous
      Gem.loaded_specs["openreceive"] = previous
    else
      Gem.loaded_specs.delete("openreceive")
    end
  end
end
