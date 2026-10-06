# frozen_string_literal: true

require "fileutils"

module OpenReceive
  module Skills
    def self.install(directory: ".agents/skills", output: $stdout)
      source = File.join(Gem.loaded_specs.fetch("openreceive").full_gem_path, "skills")
      target = File.expand_path(directory)
      names = %w[integrate-openreceive debug-openreceive-payment]
      names.each do |name|
        raise "Bundled skill missing: #{name}. Reinstall openreceive." unless File.file?(File.join(source, name, "SKILL.md"))
      end
      FileUtils.mkdir_p(target)
      target = File.realpath(target)
      source = File.realpath(source)
      if target == source || target.start_with?(source + File::SEPARATOR)
        raise "Choose a skills directory outside the installed package's bundle."
      end
      names.each do |name|
        destination = File.join(target, name)
        FileUtils.rm_r(destination) if File.exist?(destination) || File.symlink?(destination)
        FileUtils.cp_r(File.join(source, name), destination)
        output.puts "Wrote #{destination}"
      end
      output.puts "For Claude Code: bin/rails openreceive:skills --dir .claude/skills"
      0
    end
  end
end
